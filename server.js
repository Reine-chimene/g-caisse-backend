require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(bodyParser.json());

app.get('/', (req, res) => res.send('🚀 Serveur G-CAISSE en ligne et prêt !'));
app.get('/api/health', (req, res) => res.json({ status: "running" }));

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) console.error('❌ Erreur DB:', err.stack);
    else console.log('✅ Connecté à la base de données (Schéma Validé)');
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

app.get('/api/users/:id/transactions', async (req, res) => {
    try {
        const result = await db.query("SELECT id, amount, type as description, status, created_at FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); } 
});

app.get('/api/users/locations', async (req, res) => {
    try {
        const result = await db.query("SELECT id, fullname as name, latitude, longitude FROM public.users WHERE latitude IS NOT NULL");
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.put('/api/users/:id', async (req, res) => {
    const { fullname, phone } = req.body;
    try {
        await db.query("UPDATE public.users SET fullname = $1, phone = $2 WHERE id = $3", [fullname, phone, req.params.id]);
        res.status(200).json({ success: true, message: "Profil mis à jour" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 2. FINANCE (TRANSFERTS, PRÊTS, ÉPARGNE)
// ==========================================

app.post('/api/transfer', async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    try {
        await db.query('BEGIN');
        const senderRes = await db.query("SELECT balance, phone FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows.length === 0 || senderRes.rows[0].balance < amount) throw new Error("Solde insuffisant");

        const receiverRes = await db.query("SELECT id FROM public.users WHERE phone LIKE '%' || $1", [receiver_phone]);
        if (receiverRes.rows.length === 0) throw new Error("Destinataire introuvable");
        const receiver_id = receiverRes.rows[0].id;

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, sender_id]);
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE id = $2", [amount, receiver_id]);

        await db.query(`INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'transfer_out', 'wallet', 'completed')`, [sender_id, amount]);
        await db.query(`INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'transfer_in', 'wallet', 'completed')`, [receiver_id, amount]);

        await db.query('COMMIT');
        res.status(200).json({ success: true, message: "Transfert effectué" });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message });
    }
});

app.post('/api/deposit', async (req, res) => {
    const { user_id, amount } = req.body;
    try {
        await db.query("INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'deposit', 'wallet', 'pending')", [user_id, amount]);
        res.status(200).json({ success: true, message: "Demande enregistrée" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/loans/islamic', async (req, res) => {
    const { user_id, amount, purpose } = req.body;
    try {
        await db.query("INSERT INTO public.loans (borrower_id, amount_borrowed, status) VALUES ($1, $2, 'pending')", [user_id, amount]);
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/savings', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.saving_goals WHERE user_id = $1", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

// ==========================================
// 3. TONTINES & MESSAGERIE (MIS À JOUR)
// ==========================================

// Obtenir LES tontines d'un utilisateur spécifique (via query param) ou TOUTES si pas de user_id
app.get('/api/tontines', async (req, res) => {
    const userId = req.query.user_id; 
    try {
        let result;
        if (userId) {
            // Uniquement les tontines où il est admin ou membre
            result = await db.query(`
                SELECT DISTINCT t.* FROM public.tontines t
                LEFT JOIN public.tontine_members tm ON t.id = tm.tontine_id
                WHERE t.admin_id = $1 OR tm.user_id = $1
            `, [userId]);
        } else {
            // Si pas de filtre, on renvoie tout (pour compatibilité)
            result = await db.query("SELECT * FROM public.tontines");
        }
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Créer une tontine et lier l'admin
app.post('/api/tontines', async (req, res) => {
    const { name, admin_id, frequency, amount, commission_rate } = req.body;
    try {
        await db.query('BEGIN');
        
        // 1. Créer la tontine
        const tontineRes = await db.query(
            "INSERT INTO public.tontines (name, admin_id, frequency, amount_to_pay, commission_rate) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, admin_id, frequency, amount, commission_rate]
        );
        const newTontineId = tontineRes.rows[0].id;

        // 2. Ajouter l'admin comme premier membre
        await db.query(
            "INSERT INTO public.tontine_members (tontine_id, user_id) VALUES ($1, $2)",
            [newTontineId, admin_id]
        );

        await db.query('COMMIT');
        res.status(201).json({ success: true, id: newTontineId });
    } catch (err) { 
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message }); 
    } 
});

// Quitter une tontine
app.delete('/api/tontines/:id/leave', async (req, res) => {
    const { user_id } = req.body; 
    try {
        await db.query("DELETE FROM public.tontine_members WHERE tontine_id = $1 AND user_id = $2", [req.params.id, user_id]);
        res.status(200).json({ success: true, message: "Vous avez quitté la tontine" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rejoindre une tontine (Pour tes futures invitations)
app.post('/api/tontines/:id/join', async (req, res) => {
    const { user_id } = req.body;
    try {
        const check = await db.query("SELECT * FROM public.tontine_members WHERE tontine_id = $1 AND user_id = $2", [req.params.id, user_id]);
        if (check.rows.length > 0) return res.status(400).json({ message: "Déjà membre" });

        await db.query("INSERT INTO public.tontine_members (tontine_id, user_id) VALUES ($1, $2)", [req.params.id, user_id]);
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tontines/:id/members', async (req, res) => {
    try {
        const result = await db.query("SELECT u.id, u.fullname, u.phone FROM public.users u JOIN public.tontine_members tm ON u.id = tm.user_id WHERE tm.tontine_id = $1", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.get('/api/tontines/:id/messages', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.group_messages WHERE tontine_id = $1 ORDER BY created_at ASC", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.post('/api/tontines/:id/messages', async (req, res) => {
    try {
        await db.query("INSERT INTO public.group_messages (tontine_id, user_id, content) VALUES ($1, $2, $3)", [req.params.id, req.body.user_id, req.body.content]);
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tontines/:id/auctions', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.auctions WHERE tontine_id = $1", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.post('/api/tontines/:id/notify-whatsapp', (req, res) => {
    res.status(200).json({ success: true, message: "Notifications envoyées" });
});

// ==========================================
// 4. SOCIAL & NOTCH PAY
// ==========================================

app.get('/api/social/fund', async (req, res) => {
    try {
        const result = await db.query("SELECT SUM(collected_amount) as total FROM public.social_events");
        res.json({ total: result.rows[0]?.total || 0 });
    } catch (err) { res.json({ total: 0 }); }
});

app.get('/api/social/events', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.social_events");
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.post('/api/social/donate', async (req, res) => {
    try {
        await db.query("UPDATE public.social_events SET collected_amount = COALESCE(collected_amount, 0) + $2 WHERE id = $1", [req.body.event_id, req.body.amount]);
        res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Initialiser le paiement
app.post('/api/pay', async (req, res) => {
    const { amount, phone, name, email } = req.body;
    try {
        const cleanPhone = phone.replace(/\D/g, ''); 
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount: amount, currency: "XAF",
            customer: { name: name || "Membre", email: email || "contact@g-caisse.cm", phone: phone },
            reference: `REF_${cleanPhone}_${Date.now()}`,
            callback: "https://g-caisse-api.onrender.com/"
        }, { headers: { "Authorization": process.env.NOTCHPAY_KEY, "Content-Type": "application/json" }});
        res.json({ success: true, payment_url: response.data.authorization_url });
    } catch (error) { res.status(500).json({ message: "Erreur NotchPay" }); }
});

// Webhook
app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK');
    try {
        if ((event.type || event.event) === 'payment.complete') {
            const amount = event.data.amount;
            const phoneFragment = event.data.reference.split('_')[1];
            if (phoneFragment) {
                const user = await db.query("UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id", [amount, phoneFragment]);
                if (user.rows.length > 0) {
                    await db.query("INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'cotisation', 'momo', 'completed')", [user.rows[0].id, amount]);
                }
            }
        }
    } catch (err) { console.error("Webhook Erreur:", err.message); }
});

app.listen(port, () => console.log(`🚀 Serveur G-CAISSE sur le port ${port}`));