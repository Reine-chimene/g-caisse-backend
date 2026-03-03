require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
// Render utilise souvent le port 10000 par défaut, port 3000 en local
const port = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// Route de base pour vérifier que le serveur vit
app.get('/', (req, res) => res.send('🚀 Serveur G-CAISSE en ligne et prêt !'));

const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false } // Obligatoire pour Render
});

db.connect((err) => {
    if (err) console.error('❌ Erreur de connexion DB:', err.stack);
    else console.log('✅ Connecté à la base de données PostgreSQL sur Render');
});

// --- ROUTES ---

// 1. Initialiser le paiement (Notch Pay)
app.post('/api/pay', async (req, res) => {
    const { amount, phone, name, email } = req.body;
    const notchPayKey = process.env.NOTCHPAY_KEY;

    if (!notchPayKey) return res.status(500).json({ success: false, message: "Clé API manquante" });
    
    try {
        // Nettoyage du numéro pour la référence
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
        console.error("Erreur NotchPay:", error.response?.data || error.message);
        res.status(500).json({ success: false, message: "Erreur lors de l'initiation du paiement" });
    }
});

// 2. WEBHOOK : La partie qui encaisse l'argent
app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    res.status(200).send('OK'); // Réponse rapide à Notch Pay

    try {
        const eventType = event.type || event.event;
        if (eventType === 'payment.complete') {
            const amount = event.data.amount;
            const reference = event.data.reference;
            const parts = reference.split('_');

            if (parts.length >= 2) {
                const phoneFragment = parts[1]; // Le numéro extrait de la REF

                // Mise à jour du solde : on cherche par la fin du numéro pour éviter les soucis de +237
                const userUpdate = await db.query(
                    "UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id, fullname",
                    [amount, phoneFragment]
                );

                if (userUpdate.rows.length > 0) {
                    const userId = userUpdate.rows[0].id;
                    // Insertion dans l'historique avec la colonne description qu'on a ajoutée
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
        console.error("❌ Erreur Webhook critique:", err.message);
    }
});

// 3. Récupérer le solde (Utilisé par ton app Flutter)
app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        if (result.rows.length > 0) {
            res.json({ balance: result.rows[0].balance });
        } else {
            res.status(404).json({ error: "Utilisateur non trouvé" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Récupérer l'historique
app.get('/api/users/:id/transactions', async (req, res) => {
    try {
        const result = await db.query(
            "SELECT id, amount, status, description, created_at FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC",
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Login
app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        const result = await db.query('SELECT * FROM public.users WHERE phone LIKE '%' || $1 AND pincode_hash = $2', [phone, pincode]);
        if (result.rows.length > 0) res.status(200).json(result.rows[0]);
        else res.status(401).json({ error: "Identifiants incorrects" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Santé du serveur
app.get('/api/health', (req, res) => res.json({ status: "running" }));

app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE opérationnel sur le port ${port}`);
});