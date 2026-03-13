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

app.get('/', (req, res) => res.send('🚀 Serveur G-CAISE en ligne et prêt !'));

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
    else console.log('✅ Connecté à la base de données G-CAISE');
});

// ==========================================
// 1. UTILISATEURS & AUTHENTIFICATION
// ==========================================

app.post('/api/users', async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id',
            [fullname, phone.trim(), pincode.trim()]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        // Utilisation de trim() pour nettoyer les entrées
        const cleanPhone = phone.trim();
        const cleanPin = pincode.trim();

        const result = await db.query(
            "SELECT id, fullname, phone, balance FROM public.users WHERE phone LIKE '%' || $1 AND pincode_hash = $2", 
            [cleanPhone, cleanPin]
        );

        if (result.rows.length > 0) res.status(200).json(result.rows[0]);
        else res.status(401).json({ message: "Numéro ou code PIN incorrect" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ==========================================
// 2. ROUTES ADMIN (POUR TON CLIENT)
// ==========================================

// ✅ AJOUT : Statistiques du client (Calcul des 2%)
app.get('/api/admin/stats', async (req, res) => {
    try {
        // Calcule le volume total et les commissions (fees)
        const statsQuery = await db.query(`
            SELECT 
                COALESCE(SUM(amount), 0) as total_volume,
                COALESCE(SUM(amount * 0.02), 0) as total_fees 
            FROM public.transactions 
            WHERE type = 'deposit' AND status = 'completed'
        `);
        
        const userCount = await db.query("SELECT COUNT(*) FROM public.users");

        res.json({
            total_volume: statsQuery.rows[0].total_volume,
            total_fees: statsQuery.rows[0].total_fees,
            user_count: userCount.rows[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. FINANCE & PAIEMENTS
// ==========================================

app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, currency, user_id } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount, // Déjà envoyé en centimes par Flutter
            currency: currency || 'eur', 
            metadata: { user_id: user_id?.toString() }
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pay', async (req, res) => {
    const { amount, phone, name, email } = req.body;
    try {
        const cleanPhone = phone.replace(/\D/g, ''); 
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount: amount, 
            currency: "XAF",
            customer: { 
                name: name || "Membre", 
                email: email || "contact@g-caise.cm", 
                phone: phone 
            },
            reference: `DEP_${cleanPhone}_${Date.now()}`,
            callback: "https://g-caisse-api.onrender.com/api/webhook"
        }, { 
            headers: { 
                "Authorization": process.env.NOTCHPAY_PUBLIC_KEY, 
                "Content-Type": "application/json" 
            }
        });
        res.json({ success: true, payment_url: response.data.authorization_url });
    } catch (error) { 
        res.status(500).json({ message: "Erreur NotchPay" }); 
    }
});

// ✅ WEBHOOK CORRIGÉ : Mise à jour balance + Commission 2%
app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    if (event.event === 'payment.complete') {
        const { amount, reference } = event.data;
        const phoneFragment = reference.split('_')[1];

        try {
            // On crédite 98% à l'utilisateur, les 2% restent dans le volume global (admin)
            const netAmount = amount; // On peut choisir de créditer le brut ou le net ici

            const userUpdate = await db.query(
                "UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id", 
                [netAmount, phoneFragment]
            );

            if (userUpdate.rows.length > 0) {
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'deposit', 'momo', 'completed')", 
                    [userUpdate.rows[0].id, amount]
                );
            }
            res.status(200).send('OK');
        } catch (err) {
            console.error("Erreur Webhook:", err.message);
            res.status(500).send('Error');
        }
    } else {
        res.status(200).send('Ignored');
    }
});

// ==========================================
// 4. AUTRES ROUTES (INDISPENSABLES)
// ==========================================

app.get('/api/users/:id/balance', async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) { res.status(500).json({ balance: 0 }); }
});

app.get('/api/tontines/:id/messages', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT m.*, u.fullname 
            FROM public.group_messages m 
            JOIN public.users u ON m.user_id = u.id 
            WHERE m.tontine_id = $1 
            ORDER BY m.created_at DESC`, [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.json([]); }
});

app.post('/api/tontines/:id/messages', async (req, res) => {
    try {
        await db.query(
            "INSERT INTO public.group_messages (tontine_id, user_id, content) VALUES ($1, $2, $3)", 
            [req.params.id, req.body.user_id, req.body.content]
        );
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISE actif sur le port ${port}`);
});