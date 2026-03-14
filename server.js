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
// 2. FINANCE (TRANSFERTS, PRÊTS, ÉPARGNE, STRIPE)
// ==========================================

app.get('/api/admin/stats', async (req, res) => {
    try {
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-payment-intent', async (req, res) => {
    const { amount, currency, user_id } = req.body;
    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: currency || 'eur', 
            metadata: { user_id: user_id?.toString() }
        });
        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/transfer', async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    if (amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    try {
        await db.query('BEGIN');
        
        const senderRes = await db.query("SELECT balance, fullname FROM public.users WHERE id = $1", [sender_id]);
        if (senderRes.rows.length === 0 || senderRes.rows[0].balance < amount) {
            throw new Error("Solde G-Caisse insuffisant");
        }

        const userName = senderRes.rows[0].fullname || "Membre G-Caisse";
        const cleanPhone = receiver_phone.replace(/\D/g, ''); 
        let channel = "cm.mtn"; 
        if (/^(237)?(655|656|657|658|659|69|685|686|687|688|689)/.test(cleanPhone)) {
            channel = "cm.orange";
        }

        try {
            await axios.post('https://api.notchpay.co/transfers', {
                amount: amount,
                currency: "XAF",
                beneficiary_data: { name: userName, phone: `+237${cleanPhone.replace(/^237/, '')}` },
                channel: channel,
                description: "Retrait depuis G-Caisse",
                reference: `WD_${sender_id}_${Date.now()}`
            }, {
                headers: {
                    'Authorization': process.env.NOTCHPAY_PUBLIC_KEY, 
                    'X-Grant': process.env.NOTCHPAY_PRIVATE_KEY,
                    'Content-Type': 'application/json'
                }
            });

            await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, sender_id]);
            await db.query(
                `INSERT INTO public.transactions (user_id, amount, type, payment_method, status) VALUES ($1, $2, 'withdrawal', 'momo', 'completed')`, 
                [sender_id, amount]
            );

            await db.query('COMMIT');
            res.status(200).json({ success: true, message: "Retrait initié avec succès" });
        } catch (notchError) {
            throw new Error(notchError.response?.data?.message || "Erreur de transfert de l'opérateur");
        }
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
// 3. TONTINES & MESSAGERIE
// ==========================================

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
            result = await db.query(`
                SELECT t.*,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
            `);
        }
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
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

app.delete('/api/tontines/:id/leave', async (req, res) => {
    const { user_id } = req.body; 
    try {
        await db.query("DELETE FROM public.tontine_members WHERE tontine_id = $1 AND user_id = $2", [req.params.id, user_id]);
        res.status(200).json({ success: true, message: "Vous avez quitté la tontine" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

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
        const result = await db.query(`
            SELECT m.*, u.fullname 
            FROM public.group_messages m 
            JOIN public.users u ON m.user_id = u.id 
            WHERE m.tontine_id = $1 
            ORDER BY m.created_at ASC
        `, [req.params.id]);
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

// ==========================================
// 4. SOCIAL, NOTCH PAY & WEBHOOK
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

app.post('/api/pay', async (req, res) => {
    const { amount, phone, name, email } = req.body;
    try {
        const cleanPhone = phone.replace(/\D/g, ''); 
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount: amount, 
            currency: "XAF",
            customer: { name: name || "Membre", email: email || "contact@g-caise.cm", phone: phone },
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

app.post('/api/webhook', async (req, res) => {
    const event = req.body;
    const eventType = event.event || event.type; 

    if (eventType === 'payment.complete') {
        const data = event.data;
        const amount = data.amount;
        const reference = data.reference;
        const phoneFragment = reference.split('_')[1];

        try {
            const userUpdate = await db.query(
                "UPDATE public.users SET balance = balance + $1 WHERE phone LIKE '%' || $2 RETURNING id", 
                [amount, phoneFragment]
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
// 5. GÉOLOCALISATION (RADAR) - ✅ AJOUTÉ ICI
// ==========================================

// Route pour mettre à jour la position GPS d'un utilisateur
app.post('/api/users/:id/location', async (req, res) => {
    const { latitude, longitude } = req.body;
    try {
        await db.query(
            "UPDATE public.users SET latitude = $1, longitude = $2 WHERE id = $3",
            [latitude, longitude, req.params.id]
        );
        res.status(200).json({ success: true, message: "Position mise à jour" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Route pour récupérer les positions des membres d'une tontine spécifique
app.get('/api/tontines/:id/locations', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.fullname, u.latitude, u.longitude 
            FROM public.users u 
            JOIN public.tontine_members tm ON u.id = tm.user_id 
            WHERE tm.tontine_id = $1 
            AND u.latitude IS NOT NULL 
            AND u.longitude IS NOT NULL
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, async () => {
    console.log(`🚀 Serveur G-CAISSE sur le port ${port}`);
    try {
        const ipResponse = await axios.get('https://api.ipify.org');
        console.log(`🌍 >>> MON ADRESSE IP RENDER EST : ${ipResponse.data} <<< 🌍`);
    } catch (e) {
        console.log("Impossible de récupérer l'IP");
    }
});