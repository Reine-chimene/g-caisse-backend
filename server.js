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
// 1. PAIEMENTS (CAMPAY - Côté Backend)
// ==========================================

// Route appelée par l'application Flutter pour initier le paiement
app.post('/api/pay', async (req, res) => {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
        return res.status(400).json({ success: false, message: "Numéro de téléphone et montant requis." });
    }

    // Formatage du numéro (CamPay exige le code pays 237)
    const formattedPhone = phone.startsWith('237') ? phone : `237${phone}`;

    try {
        // Envoi de la requête de collecte à CamPay
        const collectResponse = await axios.post('https://demo.campay.net/api/collect/', {
            amount: amount.toString(),
            currency: "XAF",
            from: formattedPhone,
            description: "Recharge G-Caisse",
            external_reference: `REF_${Date.now()}` // Référence unique pour cette transaction
        }, {
            headers: {
                // Ton jeton d'accès permanent est gardé secret ici sur le serveur !
                "Authorization": "Token 352a84f65d57b3416f101ebc1f2d6752ad4050a2", 
                "Content-Type": "application/json"
            }
        });

        // Si la requête est acceptée par CamPay, on renvoie "success: true" à Flutter
        res.status(200).json({ success: true, data: collectResponse.data });
        console.log(`✅ Demande de paiement envoyée pour le numéro ${formattedPhone}`);

    } catch (error) {
        // Capture des erreurs renvoyées par CamPay (solde insuffisant, mauvais numéro, etc.)
        console.error("Erreur CamPay:", error.response ? error.response.data : error.message);
        res.status(500).json({ 
            success: false, 
            message: error.response && error.response.data.message 
                     ? error.response.data.message 
                     : "Erreur lors de la communication avec CamPay." 
        });
    }
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
        else res.status(401).json({ error: "Identifiants invalides" });
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