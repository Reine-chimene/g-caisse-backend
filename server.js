require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// 1. INITIALISATION DE L'APP ET DU PORT
const app = express();
const port = process.env.PORT || 3000;

// 2. MIDDLEWARES
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// 3. CONNEXION BASE DE DONNÉES
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false // Nécessaire pour Render/Railway
});

db.connect((err) => {
    if (err) console.error('❌ Erreur DB:', err.stack);
    else console.log('🗄️ Connecté à la base de données G-CAISSE');
});

// 4. INITIALISATION WHATSAPP
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Recommandé pour l'hébergement Linux
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('🌟 Scannez le QR Code ci-dessus pour connecter WhatsApp');
});

client.on('ready', () => {
    console.log('✅ Le Chatbot WhatsApp G-CAISSE est prêt !');
});

client.initialize();

// ==========================================
// 5. ROUTES DE PAIEMENT (MONETBIL)
// ==========================================

// Initier le paiement
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
            // Remplace par ton URL finale Render une fois déployé
            notify_url: process.env.WEBHOOK_URL || 'https://ton-serveur-render.com/api/payments/webhook'
        });

        res.json(response.data); 
    } catch (error) {
        console.error("Erreur Monetbil:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Echec de l'initialisation du paiement" });
    }
});

// Webhook de notification (Appelé par Monetbil)
app.post('/api/payments/webhook', async (req, res) => {
    const { status, amount, item_ref } = req.body;

    if (status === 'success') {
        const userId = item_ref.split('_')[1]; 
        
        try {
            await db.query(
                "UPDATE users SET balance = balance + $1 WHERE id = $2",
                [amount, userId]
            );
            // Enregistrer aussi dans l'historique des transactions
            await db.query(
                "INSERT INTO transactions (user_id, amount, type, status, method, created_at) VALUES ($1, $2, 'deposit', 'completed', 'mobile_money', NOW())",
                [userId, amount]
            );
            console.log(`✅ Solde mis à jour pour l'utilisateur ${userId} (+${amount} F)`);
        } catch (err) {
            console.error("Erreur mise à jour solde:", err);
        }
    }
    res.sendStatus(200);
});

// ==========================================
// 6. AUTRES ROUTES API
// ==========================================

// --- WHATSAPP NOTIFICATIONS ---
app.post('/api/tontines/:id/notify-whatsapp', async (req, res) => {
    const tontineId = req.params.id;
    try {
        const result = await db.query(
            `SELECT u.phone, u.fullname, t.name as tontine_name, t.amount_to_pay 
             FROM tontine_members m 
             JOIN users u ON m.user_id = u.id 
             JOIN tontines t ON m.tontine_id = t.id 
             WHERE t.id = $1`, [tontineId]
        );

        result.rows.forEach(member => {
            const chatId = member.phone.includes('@c.us') ? member.phone : `${member.phone}@c.us`;
            const message = `🌟 *G-CAISSE RAPPEL* 🌟\n\nBonjour ${member.fullname},\n\nC'est bientôt le jour de la tontine *${member.tontine_name}* ! 💰\nMontant à préparer : *${member.amount_to_pay} FCFA*.\n\n_G-CAISSE, la gestion transparente._`;
            client.sendMessage(chatId, message);
        });

        res.json({ message: "Rappels WhatsApp envoyés !" });
    } catch (err) {
        res.status(500).json({ error: "Échec WhatsApp" });
    }
});

// --- AUTHENTIFICATION ---
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

// --- SOLDE & TRANSACTIONS ---
app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- TONTINES ---
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

// --- SOCIAL ---
app.get('/api/social/fund', async (req, res) => {
    try {
        const result = await db.query("SELECT collected_amount FROM social_events WHERE type = 'fund' LIMIT 1");
        res.json({ total: result.rows[0]?.collected_amount || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/social/events', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM social_events WHERE status = 'active' AND type != 'fund' ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- MESSAGERIE ---
app.get('/api/tontines/:id/messages', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT m.*, u.fullname FROM group_messages m JOIN users u ON m.user_id = u.id 
             WHERE m.tontine_id = $1 ORDER BY m.created_at DESC`, [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. LANCEMENT DU SERVEUR
app.listen(port, () => console.log(`🚀 Serveur G-CAISSE lancé sur le port ${port}`));