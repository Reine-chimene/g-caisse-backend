require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

// Configuration Middlewares
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(bodyParser.json());

// Configuration Base de Données PostgreSQL
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

const GLOBAL_FEE_RATE = 0.02;

// ==========================================
// ⚙️ SCRIPT D'AUTO-MIGRATION (DB CHECK)
// ==========================================
const initDb = async () => {
    try {
        console.log("🔍 Vérification de la structure de la base de données...");
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS public.users (
                id SERIAL PRIMARY KEY,
                fullname TEXT,
                phone TEXT UNIQUE,
                pincode_hash TEXT,
                balance DECIMAL DEFAULT 0,
                credibility_score INTEGER DEFAULT 100,
                latitude DOUBLE PRECISION,
                longitude DOUBLE PRECISION,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.tontines (
                id SERIAL PRIMARY KEY,
                name TEXT,
                admin_id INTEGER REFERENCES public.users(id),
                frequency TEXT,
                amount_to_pay DECIMAL,
                commission_rate DECIMAL,
                current_beneficiary_id INTEGER REFERENCES public.users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.tontine_members (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER REFERENCES public.tontines(id),
                user_id INTEGER REFERENCES public.users(id),
                payout_method TEXT DEFAULT 'G-Caisse',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.social_funds (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER UNIQUE REFERENCES public.tontines(id),
                balance DECIMAL DEFAULT 0,
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES public.users(id),
                amount DECIMAL,
                type TEXT,
                status TEXT,
                reference TEXT,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log("✅ Base de données prête et à jour.");
    } catch (err) {
        console.error("❌ Erreur lors de l'initialisation de la DB:", err);
    }
};

initDb();

// ==========================================
// 🏠 ROUTE RACINE (ROOT)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 100px;">
            <h1 style="color: #FF7900;">🚀 SERVEUR G-CAISSE LIVE</h1>
            <p>Le backend est opérationnel sur Render.</p>
            <p>Statut Base de Données: <span style="color: green;">Connectée ✅</span></p>
        </div>
    `);
});

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
        const result = await db.query(
            "SELECT id, fullname, phone, balance, credibility_score FROM public.users WHERE (phone = $1 OR phone = '237' || $1) AND pincode_hash = $2", 
            [phone, pincode]
        );

        if (result.rows.length > 0) {
            return res.status(200).json(result.rows[0]);
        } else {
            return res.status(401).json({ message: "Numéro ou PIN incorrect" });
        }
    } catch (err) {
        console.error("Erreur Login:", err.message);
        return res.status(500).json({ message: "Erreur serveur" });
    }
});

app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.json({ balance: 0 }); }
});

// ==========================================
// 2. TONTINES & PAIEMENTS
// ==========================================

app.get('/api/tontines', async (req, res) => {
    const userId = req.query.user_id; 
    console.log("🔍 Requête tontines pour l'utilisateur ID:", userId); // Pour débugger dans Render

    try {
        let result;
        if (userId && userId !== 'null' && userId !== 'undefined') {
            result = await db.query(`
                SELECT DISTINCT t.*, t.amount_to_pay as amount,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
                LEFT JOIN public.tontine_members tm ON t.id = tm.tontine_id
                WHERE t.admin_id = $1 OR tm.user_id = $1
                ORDER BY t.created_at DESC
            `, [parseInt(userId)]); // On force l'ID en entier
        } else {
            // Si pas d'ID, on montre toutes les tontines publiques
            result = await db.query(`
                SELECT t.*, t.amount_to_pay as amount,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count 
                FROM public.tontines t 
                ORDER BY t.created_at DESC
            `);
        }
        res.json(result.rows || []);
    } catch (err) { 
        console.error("❌ Erreur GET tontines:", err.message);
        res.status(500).json({ error: err.message }); 
    }
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
        await db.query("INSERT INTO public.social_funds (tontine_id, balance) VALUES ($1, 0)", [newTontineId]);
        await db.query('COMMIT');
        res.status(201).json({ success: true, id: newTontineId });
    } catch (err) { 
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message }); 
    } 
});

// ==========================================
// 3. TRANSFERTS & RETRAITS (NOTCH PAY)
// ==========================================

// --- NOUVELLE ROUTE DE RETRAIT CORRIGÉE ---
app.post('/api/payout', async (req, res) => {
    const { user_id, amount, phone, name, channel } = req.body;
    const reference = `PAY-${Date.now()}-${user_id}`;

    try {
        await db.query('BEGIN');

        // 1. Vérifier le solde de l'utilisateur
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < amount) {
            throw new Error("Solde G-Caisse insuffisant pour ce retrait");
        }

        // 2. Appel Notch Pay avec structure BENEFICIARY correcte (Pas de 422 ici !)
        const notchResponse = await axios.post('https://api.notchpay.co/transfers', {
            amount: amount,
            currency: 'XAF',
            channel: channel || 'cm.mobile',
            beneficiary: {
                phone: phone,
                name: name
            },
            reference: reference,
            description: `Retrait G-Caisse de ${name}`
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'X-Grant': process.env.NOTCH_PRIVATE_KEY, // Requis pour les virements
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // 3. Débiter le compte G-Caisse et enregistrer la transaction pour l'AUDIT
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, $3, $4, $5, $6)",
            [user_id, amount, 'withdrawal', 'processing', reference, `Retrait Notch Pay (${channel})`]
        );

        await db.query('COMMIT');
        res.status(200).json({ success: true, data: notchResponse.data });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Erreur Payout:", err.response?.data || err.message);
        res.status(400).json({ 
            success: false, 
            message: err.response?.data?.message || err.message 
        });
    }
});

app.post('/api/transfer', async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;
    try {
        await db.query('BEGIN');
        const senderRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows[0].balance < totalToDebit) throw new Error("Solde insuffisant");
        
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, sender_id]);
        // Correction : On crédite le receveur s'il existe
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE phone = $2", [amount, receiver_phone]);
        
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'transfer', 'completed')", [sender_id, totalToDebit]);
        await db.query('COMMIT');
        res.status(200).json({ success: true });
    } catch (err) { await db.query('ROLLBACK'); res.status(400).json({ message: err.message }); }
});

// ==========================================
// 4. ADMIN & STATISTIQUES
// ==========================================

app.get('/api/admin/stats', async (req, res) => {
    try {
        const feesResult = await db.query(`
            SELECT COALESCE(SUM(amount * ${GLOBAL_FEE_RATE}), 0) as total_fees 
            FROM public.transactions 
            WHERE status = 'completed' AND type IN ('airtime', 'withdrawal', 'tontine_pay')
        `);
        const volumeResult = await db.query(`
            SELECT COALESCE(SUM(amount), 0) as total_volume 
            FROM public.transactions 
            WHERE type = 'deposit' AND status = 'completed'
        `);
        const usersResult = await db.query("SELECT COUNT(*) as user_count FROM public.users");

        res.json({
            total_fees: parseFloat(feesResult.rows[0].total_fees).toFixed(0),
            total_volume: parseFloat(volumeResult.rows[0].total_volume).toFixed(0),
            user_count: parseInt(usersResult.rows[0].user_count)
        });
    } catch (err) {
        res.status(500).json({ error: "Erreur stats" });
    }
});

// ==========================================
// 5. TRANSACTIONS & WEBHOOKS
// ==========================================

app.get('/api/users/:id/transactions', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC", [req.params.id]);
        res.json(result.rows || []);
    } catch (err) { res.json([]); } 
});

app.post('/api/deposit', async (req, res) => {
    const { amount, phone, user_id, email, name } = req.body;
    const reference = `DEP_${user_id}_${Date.now()}`; // Format CRUCIAL pour ton webhook

    try {
        const response = await axios.post('https://api.notchpay.co/payments/initialize', {
            amount: amount,
            currency: 'XAF',
            reference: reference,
            callback: 'https://google.com', // URL de retour après paiement
            customer: {
                email: email || `${phone}@g-caisse.com`,
                name: name
            }
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY, // Ta clé publique
                'Accept': 'application/json'
            }
        });

        res.json({ success: true, payment_url: response.data.authorization_url });
    } catch (err) {
        console.error("Erreur Initialisation Dépôt:", err.response?.data || err.message);
        res.status(400).json({ error: "Impossible d'initialiser le paiement" });
    }
});

app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    
    // 1. Gestion des Dépôts (Entrée d'argent)
    if (event.event === 'payment.complete') {
        const { amount, reference, status } = event.data;
        
        // On suppose que ta référence est formatée comme ceci : "DEP_USERID_TIMESTAMP"
        // Exemple : "DEP_12_1711123456" pour l'utilisateur ID 12
        const parts = reference.split('_');
        const userId = parts[1]; 

        try {
            await db.query('BEGIN');

            // Vérifier si cette transaction n'a pas déjà été traitée (Anti-doublon)
            const checkTx = await db.query("SELECT id FROM public.transactions WHERE reference = $1", [reference]);
            
            if (checkTx.rows.length === 0) {
                // Créditer l'utilisateur
                const userUpdate = await db.query(
                    "UPDATE public.users SET balance = balance + $1 WHERE id = $2 RETURNING id", 
                    [amount, userId]
                );

                if (userUpdate.rows.length > 0) {
                    // Enregistrer dans l'audit (Table transactions)
                    await db.query(
                        "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, 'deposit', 'completed', $3, $4)", 
                        [userId, amount, 'deposit', 'completed', reference, 'Dépôt Notch Pay']
                    );
                    console.log(`✅ Dépôt réussi pour l'User ${userId} : +${amount} XAF`);
                }
            }

            await db.query('COMMIT');
            return res.status(200).send('Webhook Processed');
        } catch (err) {
            await db.query('ROLLBACK');
            console.error("❌ Erreur Webhook Dépôt:", err.message);
            return res.status(500).send('Internal Server Error');
        }
    } 

    // 2. Gestion des Retraits (Confirmation de sortie d'argent)
    else if (event.event === 'transfer.complete') {
        const { reference } = event.data;
        await db.query("UPDATE public.transactions SET status = 'completed' WHERE reference = $1", [reference]);
        return res.status(200).send('Payout Confirmed');
    }

    res.status(200).send('Event Ignored');
});
// Lancement du serveur
app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE opérationnel sur le port ${port}`);
});