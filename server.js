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

// ==========================================
// ⚙️ SCRIPT D'AUTO-MIGRATION (DB CHECK)
// ==========================================
const initDb = async () => {
    try {
        console.log("🔍 Vérification de la structure de la base de données...");
        
        // 1. Table des utilisateurs (avec balance)
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

        // 2. Table des Tontines (avec bénéficiaire actuel)
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

        // 3. Table des Membres (avec mode de retrait)
        await db.query(`
            CREATE TABLE IF NOT EXISTS public.tontine_members (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER REFERENCES public.tontines(id),
                user_id INTEGER REFERENCES public.users(id),
                payout_method TEXT DEFAULT 'G-Caisse',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Table du Fond Social (Amendes)
        await db.query(`
            CREATE TABLE IF NOT EXISTS public.social_funds (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER UNIQUE REFERENCES public.tontines(id),
                balance DECIMAL DEFAULT 0,
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. Table des Transactions
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

        // Script de détection de colonnes manquantes (si les tables existaient déjà)
        await db.query(`ALTER TABLE public.tontine_members ADD COLUMN IF NOT EXISTS payout_method TEXT DEFAULT 'G-Caisse'`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS current_beneficiary_id INTEGER REFERENCES public.users(id)`);

        console.log("✅ Base de données prête et à jour.");
    } catch (err) {
        console.error("❌ Erreur lors de l'initialisation de la DB:", err);
    }
};

initDb();

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
// 2. TONTINES & PAIEMENTS (NOUVEAU)
// ==========================================

// Liste des tontines
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
            result = await db.query(`SELECT t.*, (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count FROM public.tontines t`);
        }
        res.json(result.rows || []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Créer une tontine
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
        // Création auto du fond social pour cette tontine
        await db.query("INSERT INTO public.social_funds (tontine_id, balance) VALUES ($1, 0)", [newTontineId]);
        await db.query('COMMIT');
        res.status(201).json({ success: true, id: newTontineId });
    } catch (err) { 
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message }); 
    } 
});

// Route : Paiement de cotisation + amende de retard
app.post('/api/payments/tontine', async (req, res) => {
    const { user_id, tontine_id, amount, is_late } = req.body;
    const LATE_PENALTY = 500; // Montant amende fixe

    try {
        await db.query('BEGIN');
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (userRes.rows[0].balance < amount) throw new Error("Solde insuffisant");

        // Débiter l'utilisateur
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);

        // Si retard, envoyer 500 dans le fond social
        if (is_late) {
            await db.query("UPDATE public.social_funds SET balance = balance + $1 WHERE tontine_id = $2", [LATE_PENALTY, tontine_id]);
        }

        // Enregistrer la transaction
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1, $2, 'tontine_pay', 'completed', $3)",
            [user_id, amount, is_late ? "Cotisation + Amende retard" : "Cotisation normale"]
        );

        await db.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// Route : Récupérer le bénéficiaire du tour
app.get('/api/tontines/:id/winner', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.fullname, tm.payout_method 
            FROM public.tontines t
            JOIN public.users u ON t.current_beneficiary_id = u.id
            JOIN public.tontine_members tm ON (tm.tontine_id = t.id AND tm.user_id = u.id)
            WHERE t.id = $1
        `, [req.params.id]);
        res.json(result.rows[0] || null);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Route : Récupérer le montant du Fond Social
app.get('/api/social-fund', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.social_funds");
        res.json(result.rows[0]?.balance || 0);
    } catch (err) { res.json(0); }
});

// ==========================================
// 3. SERVICES (AIRTIME, FACTURES) + 2%
// ==========================================

app.post('/api/services/airtime', async (req, res) => {
    const { user_id, receiver_phone, amount, operator } = req.body;
    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || userRes.rows[0].balance < totalToDebit) throw new Error("Solde insuffisant");

        // Appel NotchPay (Simulation NotchPay enlevée pour brièveté, reste identique à ton code)
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, user_id]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'airtime', 'completed')", [user_id, totalToDebit]);
        await db.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await db.query('ROLLBACK'); res.status(400).json({ message: err.message }); }
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
        const senderRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows[0].balance < totalToDebit) throw new Error("Solde insuffisant");

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, sender_id]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status) VALUES ($1, $2, 'withdrawal', 'completed')", [sender_id, totalToDebit]);
        await db.query('COMMIT');
        res.status(200).json({ success: true });
    } catch (err) { await db.query('ROLLBACK'); res.status(400).json({ message: err.message }); }
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