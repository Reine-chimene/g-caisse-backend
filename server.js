require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Racine
app.get('/', (req, res) => res.send('🚀 Serveur G-CAISSE en ligne !'));

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

db.connect((err) => {
    if (err) console.error('❌ Erreur DB:', err.stack);
    else console.log('🗄️ Connecté à la base de données G-CAISSE');
});

// ==========================================
// 1. PAIEMENTS (MONETBIL V2.1)
// ==========================================

app.post('/api/payments/initiate', async (req, res) => {
    const { phone, amount, operator, userId } = req.body;
    
    // Ta clé de service exacte
    const serviceKey = '0vpFvnp2xcxM3kBiHf2EUqtfMmX2PP7B'; 

    try {
        // Nouvelle URL selon la documentation v2.1
        const response = await axios.post(`https://api.monetbil.com/widget/v2.1/${serviceKey}`, {
            amount: amount,
            phone: phone,
            operator: operator, 
            currency: 'XAF',
            item_ref: `USER_${userId}`,
            notify_url: process.env.WEBHOOK_URL || 'https://g-caisse-api.onrender.com/api/payments/webhook',
            return_url: 'https://g-caisse-api.onrender.com/api/health' // Pour rediriger après paiement
        });
        
        // Monetbil va renvoyer { success: true, payment_url: "..." }
        res.json(response.data); 
    } catch (error) {
        console.error("Erreur Monetbil:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Echec Monetbil" });
    }
});

app.post('/api/payments/webhook', async (req, res) => {
    const { status, amount, item_ref } = req.body;
    if (status === 'success') {
        const userId = item_ref.split('_')[1]; 
        try {
            await db.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
            await db.query("INSERT INTO transactions (user_id, amount, type, status) VALUES ($1, $2, 'deposit', 'completed')", [userId, amount]);
            console.log(`✅ Paiement validé pour USER_${userId} : ${amount} XAF`);
        } catch (err) { console.error(err); }
    }
    res.sendStatus(200);
});

// ==========================================
// 2. TONTINES & ENCHÈRES (AUCTIONS)
// ==========================================

app.get('/api/tontines', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM tontines WHERE status = 'active'");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tontines/:id/auctions', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM auctions WHERE tontine_id = $1 ORDER BY created_at DESC", [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 3. SOCIAL & FONDS
// ==========================================

app.get('/api/social/fund', async (req, res) => {
    try {
        const result = await db.query("SELECT SUM(amount) as total FROM social_funds");
        res.json({ total: result.rows[0].total || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/social/events', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM social_events ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 4. AUTH & UTILISATEURS
// ==========================================

app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE phone = $1 AND pincode_hash = $2', [phone, pincode]);
        if (result.rows.length > 0) res.status(200).json(result.rows[0]);
        else res.status(401).json({ error: "Invalide" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const result = await db.query('INSERT INTO users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id', [fullname, phone, pincode]);
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Santé du serveur
app.get('/api/health', (req, res) => res.json({ status: "ok" }));

app.listen(port, () => console.log(`🚀 Serveur G-CAISSE lancé sur le port ${port}`));