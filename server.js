require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(bodyParser.json());

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

// ✅ TAUX DE COMMISSION FIXE (2%)
const GLOBAL_FEE_RATE = 0.02;

// ==========================================
// 1. UTILISATEURS & AUTHENTIFICATION
// ==========================================

app.post('/api/users', async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id',
            [fullname, phone, pincode]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        const result = await db.query("SELECT * FROM public.users WHERE phone LIKE '%' || $1 AND pincode_hash = $2", [phone, pincode]);
        if (result.rows.length > 0) res.status(200).json(result.rows[0]);
        else res.status(401).json({ message: "Identifiants incorrects" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.json({ balance: 0 }); }
});

// ==========================================
// 2. SERVICES (AIRTIME, DATA, FACTURES) + COMMISSION 2%
// ==========================================

app.post('/api/services/airtime', async (req, res) => {
    const { user_id, receiver_phone, amount, operator } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');

        // Vérification solde
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < totalToDebit) {
            throw new Error("Solde insuffisant pour l'achat + 2% de frais");
        }

        // Appel Notch Pay Payout pour le crédit
        const notchRes = await axios.post('https://api.notchpay.co/transfers', {
            amount: amount,
            currency: "XAF",
            beneficiary_data: { phone: receiver_phone },
            channel: operator.toLowerCase(), // mtn, orange, camtel
            description: `Recharge Airtime ${operator}`
        }, {
            headers: { 
                'Authorization': process.env.NOTCHPAY_PUBLIC_KEY,
                'X-Grant': process.env.NOTCHPAY_PRIVATE_KEY 
            }
        });

        // Mise à jour solde et transaction
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, user_id]);
        const trans = await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference) VALUES ($1, $2, 'airtime', 'completed', $3) RETURNING id",
            [user_id, totalToDebit, `AIR_${Date.now()}`]
        );

        await db.query('COMMIT');
        res.json({ 
            success: true, 
            message: `Recharge de ${amount} F réussie. Frais: ${fees} F`,
            transaction_id: trans.rows[0].id 
        });

    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// ==========================================
// 3. RETRAITS & TRANSFERTS + COMMISSION 2%
// ==========================================

app.post('/api/transfer', async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');
        
        const senderRes = await db.query("SELECT balance, fullname FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows.length === 0 || senderRes.rows[0].balance < totalToDebit) {
            throw new Error(`Solde insuffisant. Requis: ${totalToDebit} F (dont ${fees} F de frais)`);
        }

        const cleanPhone = receiver_phone.replace(/\D/g, ''); 
        let channel = "cm.mtn"; 
        if (/^(237)?(655|656|657|658|659|69|685|686|687|688|689)/.test(cleanPhone)) { channel = "cm.orange"; }

        await axios.post('https://api.notchpay.co/transfers', {
            amount: amount,
            currency: "XAF",
            beneficiary_data: { name: senderRes.rows[0].fullname, phone: `+237${cleanPhone.replace(/^237/, '')}` },
            channel: channel,
            description: "Retrait G-Caisse",
            reference: `WD_${sender_id}_${Date.now()}`
        }, {
            headers: {
                'Authorization': process.env.NOTCHPAY_PUBLIC_KEY, 
                'X-Grant': process.env.NOTCHPAY_PRIVATE_KEY
            }
        });

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, sender_id]);
        await db.query(
            `INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'withdrawal', 'completed')`, 
            [sender_id, totalToDebit]
        );

        await db.query('COMMIT');
        res.status(200).json({ success: true, message: `Retrait réussi. Frais déduits: ${fees} F` });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message });
    }
});

// ==========================================
// 4. GÉNÉRATION DE REÇU (DATA POUR QR CODE & PDF)
// ==========================================

app.get('/api/transactions/:id/receipt', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT t.*, u.fullname, u.phone 
            FROM public.transactions t 
            JOIN public.users u ON t.user_id = u.id 
            WHERE t.id = $1
        `, [req.params.id]);

        if (result.rows.length === 0) return res.status(404).json({ message: "Transaction non trouvée" });

        const tx = result.rows[0];
        const receiptData = {
            receipt_no: `GC-${tx.id}`,
            date: tx.created_at,
            client: tx.fullname,
            amount: tx.amount,
            fee: tx.amount * (GLOBAL_FEE_RATE / (1 + GLOBAL_FEE_RATE)), // Calcul inverse des frais
            type: tx.type,
            qr_code: `https://g-caise.cm/verify/${tx.id}` // Le lien que le QR code contiendra
        };

        res.json(receiptData);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ ROUTE : PAIEMENT FACTURE ENEO (ÉLECTRICITÉ) + 2%
app.post('/api/services/eneo', async (req, res) => {
    const { user_id, contract_number, amount } = req.body;
    const fees = amount * GLOBAL_FEE_RATE; // GLOBAL_FEE_RATE = 0.02
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');

        // 1. Vérification solde
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < totalToDebit) {
            throw new Error("Solde insuffisant (Montant + 2% de frais)");
        }

        // 2. Appel Notch Pay Bills pour ENEO
        // Note: L'endpoint et le format dépendent de Notch Pay, souvent /bills
        const notchRes = await axios.post('https://api.notchpay.co/bills', {
            amount: amount,
            currency: "XAF",
            provider: "eneo",
            biller_data: { contract_number: contract_number },
            description: `Paiement ENEO Contrat: ${contract_number}`
        }, {
            headers: { 'Authorization': process.env.NOTCHPAY_PRIVATE_KEY }
        });

        if (notchRes.status === 201 || notchRes.status === 200) {
            // 3. Mise à jour solde et transaction
            await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, user_id]);
            await db.query(
                "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1, $2, 'eneo_bill', 'completed', $3)",
                [user_id, totalToDebit, `Facture ENEO ${contract_number}`]
            );

            await db.query('COMMIT');
            res.json({ success: true, message: `Facture ENEO payée. Frais: ${fees} F` });
        }
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// ✅ ROUTE : PAIEMENT FACTURE CAMWATER (EAU) + 2%
app.post('/api/services/camwater', async (req, res) => {
    // Exactement la même logique que ENEO, mais avec provider: "camwater"
});

// ==========================================
// 5. WEBHOOK & AUTRES (GARDÉS SANS CHANGEMENT)
// ==========================================

app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'payment.complete') {
        const { amount, reference } = event.data;
        const phoneFragment = reference.split('_')[1];
        try {
            const userUpdate = await db.query(
                "UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id", 
                [amount, phoneFragment]
            );
            if (userUpdate.rows.length > 0) {
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'deposit', 'completed')", 
                    [userUpdate.rows[0].id, amount]
                );
            }
            res.status(200).send('OK');
        } catch (err) { res.status(500).send('Error'); }
    } else { res.status(200).send('Ignored'); }
});

// --- ROUTES RESTANTES (TONTINES, LOCATIONS, ETC.) ---
// [Ici tes routes tontines existantes sont conservées telles quelles]

app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE (Version Business) sur le port ${port}`);
});