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

app.get('/api/users/:id/trust-score', async (req, res) => {
    try {
        const result = await db.query("SELECT COALESCE(credibility_score, 100) as trust_score FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ trust_score: result.rows[0]?.trust_score || 100 });
    } catch (err) { res.json({ trust_score: 100 }); }
});

// ==========================================
// 2. TONTINES (RÉINTÉGRÉ)
// ==========================================

app.get('/api/tontines', async (req, res) => {
    const userId = req.query.user_id; 
    try {
        let result;
        if (userId) {
            result = await db.query(`
                SELECT DISTINCT t.*,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
                LEFT JOIN public.tontine_members tm ON t.id = tm.tontine_id
                WHERE t.admin_id = $1 OR tm.user_id = $1
            `, [userId]);
        } else {
            result = await db.query(`
                SELECT t.*,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
            `);
        }
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tontines', async (req, res) => {
    const { name, admin_id, frequency, amount, commission_rate } = req.body;
    try {
        await db.query('BEGIN');
        const tontineRes = await db.query(
            "INSERT INTO public.tontines (name, admin_id, frequency, amount_to_pay, commission_rate) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, admin_id, frequency, amount, commission_rate]
        );
        const newTontineId = tontineRes.rows[0].id;
        await db.query("INSERT INTO public.tontine_members (tontine_id, user_id) VALUES ($1, $2)", [newTontineId, admin_id]);
        await db.query('COMMIT');
        res.status(201).json({ success: true, id: newTontineId });
    } catch (err) { 
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message }); 
    } 
});

// ==========================================
// 3. SERVICES (AIRTIME, DATA, FACTURES) + 2%
// ==========================================

app.post('/api/services/airtime', async (req, res) => {
    const { user_id, receiver_phone, amount, operator } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < totalToDebit) {
            throw new Error("Solde insuffisant pour l'achat + 2% de frais");
        }

        const notchRes = await axios.post('https://api.notchpay.co/transfers', {
            amount: amount,
            currency: "XAF",
            beneficiary_data: { phone: receiver_phone },
            channel: operator.toLowerCase(),
            description: `Recharge Airtime ${operator}`
        }, {
            headers: { 
                'Authorization': process.env.NOTCHPAY_PUBLIC_KEY,
                'X-Grant': process.env.NOTCHPAY_PRIVATE_KEY 
            }
        });

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, user_id]);
        const trans = await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference) VALUES ($1, $2, 'airtime', 'completed', $3) RETURNING id",
            [user_id, totalToDebit, `AIR_${Date.now()}`]
        );

        await db.query('COMMIT');
        res.json({ success: true, message: `Recharge réussie. Frais: ${fees} F`, transaction_id: trans.rows[0].id });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// ROUTE FACTURES GÉNÉRIQUE (ENEO & CAMWATER)
app.post('/api/services/:provider', async (req, res) => {
    const { provider } = req.params; // eneo ou camwater
    const { user_id, contract_number, amount } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < totalToDebit) throw new Error("Solde insuffisant");

        await axios.post('https://api.notchpay.co/bills', {
            amount: amount,
            currency: "XAF",
            provider: provider,
            biller_data: { contract_number: contract_number },
            description: `Paiement ${provider.toUpperCase()} Contrat: ${contract_number}`
        }, {
            headers: { 'Authorization': process.env.NOTCHPAY_PRIVATE_KEY }
        });

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1, $2, $3, 'completed', $4)",
            [user_id, totalToDebit, `${provider}_bill`, `Facture ${provider.toUpperCase()} ${contract_number}`]
        );
        await db.query('COMMIT');
        res.json({ success: true, message: `Facture ${provider.toUpperCase()} payée.` });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// ==========================================
// 4. RETRAITS & TRANSFERTS + 2%
// ==========================================

app.post('/api/transfer', async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');
        const senderRes = await db.query("SELECT balance, fullname FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows.length === 0 || senderRes.rows[0].balance < totalToDebit) {
            throw new Error(`Solde insuffisant. Requis: ${totalToDebit} F (frais inclus)`);
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
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'withdrawal', 'completed')", [sender_id, totalToDebit]);
        await db.query('COMMIT');
        res.status(200).json({ success: true, message: `Retrait réussi. Frais: ${fees} F` });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message });
    }
});

// ==========================================
// 5. REÇUS, MESSAGERIE & GÉOLOCALISATION
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
        res.json({
            receipt_no: `GC-${tx.id}`,
            date: tx.created_at,
            client: tx.fullname,
            amount: tx.amount,
            fee: tx.amount * (GLOBAL_FEE_RATE / (1 + GLOBAL_FEE_RATE)),
            type: tx.type,
            qr_code: `https://g-caise.cm/verify/${tx.id}`
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/:id/location', async (req, res) => {
    const { latitude, longitude } = req.body;
    try {
        await db.query("UPDATE public.users SET latitude = $1, longitude = $2 WHERE id = $3", [latitude, longitude, req.params.id]);
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/transactions', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC", [req.params.id]);
        res.json(result.rows || []);
    } catch (err) { res.json([]); } 
});

// ==========================================
// 6. FINANCES (STRIPE, WEBHOOK)
// ==========================================

app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, currency, user_id } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: currency || 'eur', 
            metadata: { user_id: user_id?.toString() }
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'payment.complete') {
        const { amount, reference } = event.data;
        const phoneFragment = reference.split('_')[1];
        try {
            const userUpdate = await db.query("UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id", [amount, phoneFragment]);
            if (userUpdate.rows.length > 0) {
                await db.query("INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'deposit', 'completed')", [userUpdate.rows[0].id, amount]);
            }
            res.status(200).send('OK');
        } catch (err) { res.status(500).send('Error'); }
    } else { res.status(200).send('Ignored'); }
});

app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE (Version Business) sur le port ${port}`);
});