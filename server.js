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

// Santé du serveur
app.get('/', (req, res) => res.send('🚀 Serveur G-CAISSE en ligne et prêt !'));
app.get('/api/health', (req, res) => res.json({ status: "running" }));

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false } // Obligatoire pour Render
});

db.connect((err) => {
    if (err) console.error('❌ Erreur DB:', err.stack);
    else console.log('✅ Connecté à la base de données PostgreSQL sur Render');
});

// ==========================================
// --- ROUTES DE L'APPLICATION FLUTTER ---
// ==========================================

// 1. INSCRIPTION (Pour créer un nouveau compte)
app.post('/api/users', async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id',
            [fullname, phone, pincode]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) { 
        console.error("Erreur Inscription:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 2. CONNEXION (Correction des guillemets SQL)
app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        // Utilisation de guillemets doubles pour éviter de casser la chaîne SQL
        const result = await db.query(
            "SELECT * FROM public.users WHERE phone LIKE '%' || $1 AND pincode_hash = $2", 
            [phone, pincode]
        );
        if (result.rows.length > 0) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(401).json({ error: "Identifiants incorrects" });
        }
    } catch (err) { 
        console.error("Erreur Login:", err.message);
        res.status(500).json({ error: err.message }); 
    }
});

// 3. RÉCUPÉRER LE SOLDE
app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. RÉCUPÉRER LE SCORE DE CONFIANCE (Pour le profil VIP)
app.get('/api/users/:id/trust-score', async (req, res) => {
    try {
        res.json({ trust_score: 100 }); // Score de base
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. HISTORIQUE DES TRANSACTIONS
app.get('/api/users/:id/transactions', async (req, res) => {
    try {
        const result = await db.query(
            "SELECT id, amount, type as description, created_at FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC",
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. INITIALISER LE PAIEMENT (NOTCH PAY)
app.post('/api/pay', async (req, res) => {
    const { amount, phone, name, email } = req.body;
    const notchPayKey = process.env.NOTCHPAY_KEY;

    if (!notchPayKey) return res.status(500).json({ success: false, message: "Clé API manquante" });
    
    try {
        const cleanPhone = phone.replace(/\D/g, ''); 
        const transactionRef = `REF_${cleanPhone}_${Date.now()}`;

        const response = await axios.post('https://api.notchpay.co/payments', {
            amount: amount,
            currency: "XAF",
            customer: {
                name: name || "Membre G-Caisse",
                email: email || "contact@g-caisse.cm",
                phone: phone
            },
            description: "Cotisation G-Caisse",
            reference: transactionRef,
            callback: "https://g-caisse-api.onrender.com/"
        }, {
            headers: {
                "Authorization": notchPayKey,
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
        });

        res.json({ success: true, payment_url: response.data.authorization_url });
    } catch (error) {
        res.status(500).json({ success: false, message: "Erreur NotchPay" });
    }
});

// 7. WEBHOOK : REÇOIT L'ARGENT DE NOTCH PAY
app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK');

    try {
        const eventType = event.type || event.event;
        if (eventType === 'payment.complete') {
            const amount = event.data.amount;
            const reference = event.data.reference;
            const parts = reference.split('_');

            if (parts.length >= 2) {
                const phoneFragment = parts[1];
                const userUpdate = await db.query(
                    "UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id, fullname",
                    [amount, phoneFragment]
                );

                if (userUpdate.rows.length > 0) {
                    const userId = userUpdate.rows[0].id;
                    await db.query(
                        `INSERT INTO public.transactions (user_id, amount, type, payment_method, status, description) 
                         VALUES ($1, $2, 'cotisation', 'momo', 'completed', 'Dépôt Notch Pay')`,
                        [userId, amount]
                    );
                    console.log(`💰 SOLDE MIS À JOUR : +${amount} pour ${userUpdate.rows[0].fullname}`);
                }
            }
        }
    } catch (err) {
        console.error("❌ Erreur Webhook:", err.message);
    }
});

// 8. TONTINES
app.get('/api/tontines', async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.tontines WHERE status = 'active'");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE opérationnel sur le port ${port}`);
});