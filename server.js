require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
// const { Client, LocalAuth } = require('whatsapp-web.js'); // Désactivé pour Render
// const qrcode = require('qrcode-terminal'); // Désactivé pour Render
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Racine du serveur pour tester si ça marche
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

// --- WHATSAPP DÉSACTIVÉ TEMPORAIREMENT POUR ÉVITER LE CRASH RENDER ---
/*
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('🌟 Scannez le QR Code');
});

client.on('ready', () => console.log('✅ Chatbot prêt !'));
client.initialize();
*/

// ==========================================
// 5. ROUTES DE PAIEMENT (MONETBIL)
// ==========================================

app.post('/api/payments/initiate', async (req, res) => {
    const { phone, amount, operator, userId } = req.body;
    try {
        const response = await axios.post('https://api.monetbil.com/payment/v1/placePayment', {
            service: '0vpFvnp2xcxM3kBiHf2EUqtfMmX2PP7B', 
            amount: amount,
            currency: 'XAF',
            phonenumber: phone,
            operator: operator, 
            item_ref: `USER_${userId}`,
            description: 'Depot G-Caisse',
            notify_url: process.env.WEBHOOK_URL || 'https://g-caisse-api.onrender.com/api/payments/webhook'
        });
        res.json(response.data); 
    } catch (error) {
        console.error("Erreur Monetbil:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Echec de l'initialisation du paiement" });
    }
});

app.post('/api/payments/webhook', async (req, res) => {
    const { status, amount, item_ref } = req.body;
    if (status === 'success') {
        const userId = item_ref.split('_')[1]; 
        try {
            await db.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [amount, userId]);
            await db.query(
                "INSERT INTO transactions (user_id, amount, type, status, method, created_at) VALUES ($1, $2, 'deposit', 'completed', 'mobile_money', NOW())",
                [userId, amount]
            );
            console.log(`✅ Solde mis à jour (+${amount} F)`);
        } catch (err) { console.error("Erreur mise à jour solde:", err); }
    }
    res.sendStatus(200);
});

// ==========================================
// 6. AUTRES ROUTES API
// ==========================================

app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE phone = $1 AND pincode_hash = $2', [phone, pincode]);
        if (result.rows.length > 0) res.status(200).json(result.rows[0]);
        else res.status(401).json({ error: "Identifiants incorrects" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id',
            [fullname, phone, pincode]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tontines', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM tontines WHERE status = 'active'");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tontines', async (req, res) => {
    const { name, admin_id, frequency, amount, commission_rate } = req.body;
    try {
        await db.query(
            'INSERT INTO tontines (name, admin_id, frequency, amount_to_pay, commission_rate, status) VALUES ($1, $2, $3, $4, $5, \'active\')',
            [name, admin_id, frequency, amount, commission_rate]
        );
        res.sendStatus(201);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Route test simple
app.get('/api/health', (req, res) => res.json({ status: "ok", message: "Le serveur de Reine fonctionne !" }));

app.listen(port, () => console.log(`🚀 Serveur G-CAISSE lancé sur le port ${port}`));