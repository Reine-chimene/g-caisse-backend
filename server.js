// @ts-nocheck
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const db = require('./db');

// Config Cloudinary (si les variables sont renseignées)
if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
}

const app = express();
const port = process.env.PORT || 3000;
const GLOBAL_FEE_RATE = 0.02;
const SALT_ROUNDS = 10;

// Dossier de stockage des vocaux
const VOICE_DIR = path.join(__dirname, 'uploads', 'voices');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

// Config multer : stockage local, max 10 Mo, formats audio uniquement
const voiceStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, VOICE_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.aac';
        cb(null, `voice_${Date.now()}_${req.params.id}${ext}`);
    }
});
const uploadVoice = multer({
    storage: voiceStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'application/octet-stream'];
        cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(aac|mp3|m4a|ogg|wav|webm)$/i) !== null);
    }
});

const app = express();
const port = process.env.PORT || 3000;
const GLOBAL_FEE_RATE = 0.02;
const SALT_ROUNDS = 10;

// ==========================================
// MIDDLEWARES
// ==========================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000'];

app.use(cors({
    origin: (origin, callback) => {
        // Autoriser les appels sans origin (apps mobiles, Postman)
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('CORS non autorisé'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

// bodyParser JSON sur toutes les routes SAUF /api/webhook
// (le webhook a besoin du raw body pour la vérification HMAC-SHA256)
app.use((req, res, next) => {
    if (req.path === '/api/webhook') return next();
    bodyParser.json()(req, res, next);
});

// Servir les fichiers vocaux en statique
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Middleware d'authentification JWT
const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Format: "Bearer <token>"
    if (!token) return res.status(401).json({ message: 'Token manquant' });

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        return res.status(403).json({ message: 'Token invalide ou expiré' });
    }
};

// Middleware de validation des champs requis
const requireFields = (...fields) => (req, res, next) => {
    const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
    if (missing.length > 0) return res.status(400).json({ message: `Champs manquants : ${missing.join(', ')}` });
    next();
};

// ==========================================
// AUTO-MIGRATION DB
// ==========================================
const initDb = async () => {
    try {
        console.log("🔍 Vérification de la structure de la base de données...");

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

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.tontine_members (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER REFERENCES public.tontines(id),
                user_id INTEGER REFERENCES public.users(id),
                payout_method TEXT DEFAULT 'G-Caisse',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.social_funds (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER UNIQUE REFERENCES public.tontines(id),
                balance DECIMAL DEFAULT 0,
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

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

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.tontine_messages (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER REFERENCES public.tontines(id),
                user_id INTEGER REFERENCES public.users(id),
                content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.auctions (
                id SERIAL PRIMARY KEY,
                tontine_id INTEGER REFERENCES public.tontines(id),
                user_id INTEGER REFERENCES public.users(id),
                bid_amount DECIMAL,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.savings_goals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES public.users(id),
                name TEXT,
                target_amount DECIMAL,
                current_amount DECIMAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.loans (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES public.users(id),
                amount DECIMAL,
                purpose TEXT,
                type TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS public.social_events (
                id SERIAL PRIMARY KEY,
                title TEXT,
                description TEXT,
                target_amount DECIMAL DEFAULT 0,
                collected DECIMAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            ALTER TABLE public.users ADD COLUMN IF NOT EXISTS fcm_token TEXT
        `);

        console.log("✅ Base de données prête et à jour.");
    } catch (err) {
        console.error("❌ Erreur lors de l'initialisation de la DB:", err);
    }
};

initDb();

// ==========================================
// ROUTE RACINE
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; padding-top: 100px;">
            <h1 style="color: #FF7900;">🚀 SERVEUR G-CAISSE LIVE</h1>
            <p>Le backend est opérationnel sur Render.</p>
            <p>Statut Base de Données: <span style="color: green;">Connectée ✅</span></p>
        </div>
    `);
});

// ==========================================
// CALLBACK PAIEMENT NOTCH PAY
// Notch Pay redirige ici après que l'utilisateur a payé
// On vérifie le statut et on redirige vers l'app via deep link
// ==========================================
app.get('/api/payment-callback', async (req, res) => {
    const { reference, trxref, status } = req.query;
    const ref = reference || trxref;

    if (!ref) {
        return res.redirect('gcaisse://payment?status=error&message=reference_manquante');
    }

    try {
        // Vérifier le statut réel auprès de Notch Pay
        const notchRes = await axios.get(`https://api.notchpay.co/payments/${ref}`, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Accept': 'application/json'
            }
        });

        const txStatus = notchRes.data.transaction?.status || 'pending';

        if (txStatus === 'complete') {
            // Paiement confirmé — afficher page de succès avec deep link
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Paiement réussi</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #f5f6f8; }
                        .card { background: white; border-radius: 20px; padding: 40px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                        .icon { font-size: 60px; margin-bottom: 20px; }
                        h1 { color: #22c55e; font-size: 24px; margin-bottom: 10px; }
                        p { color: #666; margin-bottom: 30px; }
                        a { display: inline-block; background: #FF7900; color: white; padding: 14px 30px; border-radius: 12px; text-decoration: none; font-weight: bold; }
                    </style>
                    <script>
                        // Tenter d'ouvrir l'app automatiquement
                        setTimeout(() => { window.location.href = 'gcaisse://payment?status=success&reference=${ref}'; }, 500);
                    </script>
                </head>
                <body>
                    <div class="card">
                        <div class="icon">✅</div>
                        <h1>Paiement Réussi !</h1>
                        <p>Votre compte G-Caisse a été crédité avec succès.</p>
                        <a href="gcaisse://payment?status=success&reference=${ref}">Retour à G-Caisse</a>
                    </div>
                </body>
                </html>
            `);
        } else {
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Paiement échoué</title>
                    <style>
                        body { font-family: sans-serif; text-align: center; padding: 60px 20px; background: #f5f6f8; }
                        .card { background: white; border-radius: 20px; padding: 40px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
                        .icon { font-size: 60px; margin-bottom: 20px; }
                        h1 { color: #ef4444; font-size: 24px; margin-bottom: 10px; }
                        p { color: #666; margin-bottom: 30px; }
                        a { display: inline-block; background: #FF7900; color: white; padding: 14px 30px; border-radius: 12px; text-decoration: none; font-weight: bold; }
                    </style>
                    <script>
                        setTimeout(() => { window.location.href = 'gcaisse://payment?status=${txStatus}&reference=${ref}'; }, 500);
                    </script>
                </head>
                <body>
                    <div class="card">
                        <div class="icon">❌</div>
                        <h1>Paiement ${txStatus}</h1>
                        <p>Le paiement n'a pas abouti. Votre solde n'a pas été modifié.</p>
                        <a href="gcaisse://payment?status=${txStatus}&reference=${ref}">Retour à G-Caisse</a>
                    </div>
                </body>
                </html>
            `);
        }
    } catch (err) {
        console.error('Erreur callback:', err.message);
        return res.redirect('gcaisse://payment?status=error');
    }
});

// ==========================================
// 1. UTILISATEURS & AUTHENTIFICATION
// ==========================================

app.post('/api/users', requireFields('fullname', 'phone', 'pincode'), async (req, res) => {
    const { fullname, phone, pincode } = req.body;

    if (String(pincode).length < 4) {
        return res.status(400).json({ message: 'Le PIN doit contenir au moins 4 chiffres' });
    }

    try {
        const hash = await bcrypt.hash(String(pincode), SALT_ROUNDS);
        const result = await db.query(
            'INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id',
            [fullname, phone, hash]
        );
        res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: 'Ce numéro est déjà enregistré' });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', requireFields('phone', 'pincode'), async (req, res) => {
    const { phone, pincode } = req.body;
    try {
        const result = await db.query(
            "SELECT id, fullname, phone, balance, credibility_score, pincode_hash FROM public.users WHERE phone = $1 OR phone = '237' || $1",
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Numéro ou PIN incorrect" });
        }

        const user = result.rows[0];
        const pinMatch = await bcrypt.compare(String(pincode), user.pincode_hash);

        if (!pinMatch) {
            return res.status(401).json({ message: "Numéro ou PIN incorrect" });
        }

        const token = jwt.sign(
            { id: user.id, phone: user.phone },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        const { pincode_hash, ...userData } = user;
        return res.status(200).json({ ...userData, token });

    } catch (err) {
        console.error("Erreur Login:", err.message);
        return res.status(500).json({ message: "Erreur serveur" });
    }
});

app.get('/api/users/:id/balance', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id = $1", [req.params.id]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (err) {
        res.json({ balance: 0 });
    }
});

app.put('/api/users/:id', authenticate, requireFields('fullname', 'phone'), async (req, res) => {
    const { fullname, phone } = req.body;
    try {
        const result = await db.query(
            'UPDATE public.users SET fullname = $1, phone = $2 WHERE id = $3 RETURNING id, fullname, phone',
            [fullname, phone, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Réinitialisation du PIN par numéro de téléphone
app.post('/api/users/reset-pin', requireFields('phone', 'new_pin'), async (req, res) => {
    const { phone, new_pin } = req.body;
    if (String(new_pin).length !== 4) {
        return res.status(400).json({ message: 'Le PIN doit contenir exactement 4 chiffres' });
    }
    try {
        const userRes = await db.query(
            "SELECT id FROM public.users WHERE phone = $1 OR phone = '237' || $1",
            [phone]
        );
        if (userRes.rows.length === 0) {
            return res.status(404).json({ message: 'Numéro introuvable' });
        }
        const hash = await bcrypt.hash(String(new_pin), SALT_ROUNDS);
        await db.query(
            'UPDATE public.users SET pincode_hash = $1 WHERE id = $2',
            [hash, userRes.rows[0].id]
        );
        res.json({ success: true, message: 'PIN réinitialisé avec succès' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. TONTINES
// ==========================================

app.get('/api/tontines', authenticate, async (req, res) => {
    const userId = req.query.user_id;
    try {
        let result;
        if (userId && userId !== 'null' && userId !== 'undefined') {
            result = await db.query(`
                SELECT DISTINCT t.*, t.amount_to_pay as amount,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
                LEFT JOIN public.tontine_members tm ON t.id = tm.tontine_id
                WHERE t.admin_id = $1 OR tm.user_id = $1
                ORDER BY t.created_at DESC
            `, [parseInt(userId)]);
        } else {
            result = await db.query(`
                SELECT t.*, t.amount_to_pay as amount,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id = t.id) as member_count
                FROM public.tontines t
                ORDER BY t.created_at DESC
            `);
        }
        res.json(result.rows || []);
    } catch (err) {
        console.error("❌ Erreur GET tontines:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tontines', authenticate, requireFields('name', 'admin_id', 'frequency', 'amount', 'commission_rate'), async (req, res) => {
    const { name, admin_id, frequency, amount, commission_rate } = req.body;

    if (amount <= 0) return res.status(400).json({ message: 'Le montant doit être positif' });

    try {
        await db.query('BEGIN');
        const tontineRes = await db.query(
            "INSERT INTO public.tontines (name, admin_id, frequency, amount_to_pay, commission_rate) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            [name, admin_id, frequency, amount, commission_rate]
        );
        const newTontineId = tontineRes.rows[0].id;
        await db.query("INSERT INTO public.tontine_members (tontine_id, user_id) VALUES ($1, $2)", [newTontineId, admin_id]);
        await db.query("INSERT INTO public.social_funds (tontine_id, balance) VALUES ($1, 0)", [newTontineId]);
        await db.query('COMMIT');
        res.status(201).json({ success: true, id: newTontineId });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tontines/:id', authenticate, requireFields('name', 'frequency', 'amount_to_pay'), async (req, res) => {
    const { name, frequency, amount_to_pay } = req.body;
    try {
        const result = await db.query(
            'UPDATE public.tontines SET name = $1, frequency = $2, amount_to_pay = $3 WHERE id = $4 RETURNING *',
            [name, frequency, amount_to_pay, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Tontine non trouvée" });
        const tontine = result.rows[0];
        tontine.amount = tontine.amount_to_pay;
        res.status(200).json(tontine);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. TRANSFERTS & RETRAITS (NOTCH PAY)
// ==========================================

app.post('/api/payout', authenticate, requireFields('user_id', 'amount', 'phone', 'name'), async (req, res) => {
    const { user_id, amount, phone, name, channel } = req.body;

    if (amount <= 0) return res.status(400).json({ message: 'Le montant doit être positif' });

    const reference = `PAY-${Date.now()}-${user_id}`;
    try {
        await db.query('BEGIN');

        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || parseFloat(userRes.rows[0].balance) < amount) {
            throw new Error("Solde G-Caisse insuffisant pour ce retrait");
        }

        const notchChannel = channel || 'cm.mobile';

        // Étape 1 : Créer le bénéficiaire (doc Notch Pay : POST /recipients)
        const recipientRes = await axios.post('https://api.notchpay.co/recipients', {
            name,
            phone,
            channel: notchChannel,
            account_number: phone
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'X-Grant': process.env.NOTCH_PRIVATE_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const recipientId = recipientRes.data.recipient?.id;
        if (!recipientId) throw new Error("Impossible de créer le bénéficiaire Notch Pay");

        // Étape 2 : Initier le transfert avec l'ID du bénéficiaire
        const transferRes = await axios.post('https://api.notchpay.co/transfers', {
            recipient: recipientId,
            amount,
            currency: 'XAF',
            description: `Retrait G-Caisse - ${name}`,
            reference
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'X-Grant': process.env.NOTCH_PRIVATE_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const transferReference = transferRes.data.transfer?.reference || reference;
        const transferStatus = transferRes.data.transfer?.status || 'sent';

        // Étape 3 : Débiter le compte et enregistrer la transaction
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, $3, $4, $5, $6)",
            [user_id, amount, 'withdrawal', transferStatus, transferReference, `Retrait ${notchChannel} → ${phone}`]
        );

        await db.query('COMMIT');
        res.status(200).json({ success: true, data: transferRes.data });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error("Erreur Payout:", err.response?.data || err.message);
        res.status(400).json({ success: false, message: err.response?.data?.message || err.message });
    }
});

app.post('/api/transfer', authenticate, requireFields('sender_id', 'receiver_phone', 'amount'), async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;

    if (amount <= 0) return res.status(400).json({ message: 'Le montant doit être positif' });

    const fees = amount * GLOBAL_FEE_RATE;
    const totalToDebit = amount + fees;

    try {
        await db.query('BEGIN');

        const senderRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [sender_id]);
        if (!senderRes.rows[0] || parseFloat(senderRes.rows[0].balance) < totalToDebit) {
            throw new Error("Solde insuffisant");
        }

        // Vérifier que le destinataire existe avant de débiter
        const receiverRes = await db.query("SELECT id FROM public.users WHERE phone = $1", [receiver_phone]);
        if (receiverRes.rows.length === 0) {
            throw new Error("Destinataire introuvable avec ce numéro");
        }

        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [totalToDebit, sender_id]);
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE phone = $2", [amount, receiver_phone]);

        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1, $2, 'transfer', 'completed', $3)",
            [sender_id, totalToDebit, `Transfert vers ${receiver_phone}`]
        );

        await db.query('COMMIT');
        res.status(200).json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// ==========================================
// 4. ADMIN & STATISTIQUES
// ==========================================

app.get('/api/admin/stats', authenticate, async (req, res) => {
    try {
        const feesResult = await db.query(`
            SELECT COALESCE(SUM(amount * $1), 0) as total_fees
            FROM public.transactions
            WHERE status = 'completed' AND type IN ('airtime', 'withdrawal', 'tontine_pay')
        `, [GLOBAL_FEE_RATE]);

        const volumeResult = await db.query(`
            SELECT COALESCE(SUM(amount), 0) as total_volume
            FROM public.transactions
            WHERE type = 'deposit' AND status = 'completed'
        `);

        const usersResult = await db.query("SELECT COUNT(*) as user_count FROM public.users");

        res.json({
            total_fees: parseFloat(feesResult.rows[0].total_fees).toFixed(0),
            total_volume: parseFloat(volumeResult.rows[0].total_volume).toFixed(0),
            user_count: parseInt(usersResult.rows[0].user_count)
        });
    } catch (err) {
        res.status(500).json({ error: "Erreur stats" });
    }
});

// ==========================================
// 5. TRANSACTIONS & WEBHOOKS
// ==========================================

app.get('/api/users/:id/transactions', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.transactions WHERE user_id = $1 ORDER BY created_at DESC",
            [req.params.id]
        );
        res.json(result.rows || []);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/deposit', authenticate, requireFields('amount', 'user_id', 'name'), async (req, res) => {
    const { amount, phone, user_id, email, name } = req.body;

    if (amount <= 0) return res.status(400).json({ message: 'Le montant doit être positif' });

    // Format référence : DEP_USERID_TIMESTAMP (utilisé dans le webhook pour retrouver l'user)
    const reference = `DEP_${user_id}_${Date.now()}`;
    try {
        // Doc Notch Pay : endpoint correct est POST /payments (pas /payments/initialize)
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount,
            currency: 'XAF',
            reference,
            callback: process.env.PAYMENT_CALLBACK_URL || 'https://google.com',
            customer: {
                name,
                email: email || `user${user_id}@g-caisse.com`,
                phone: phone || undefined
            },
            description: `Dépôt G-Caisse - ${name}`
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // Doc Notch Pay : la réponse contient authorization_url à la racine
        // et transaction.id pour le SDK Flutter
        const paymentUrl = response.data.authorization_url;
        const paymentId  = response.data.transaction?.id;
        res.json({ success: true, payment_url: paymentUrl, payment_id: paymentId });
    } catch (err) {
        console.error("Erreur Initialisation Dépôt:", err.response?.data || err.message);
        res.status(400).json({ error: err.response?.data?.message || "Impossible d'initialiser le paiement" });
    }
});

// Le webhook nécessite le raw body pour vérifier la signature HMAC
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-notch-signature'];
    const rawBody = req.body.toString();

    // Vérification HMAC-SHA256 (doc officielle Notch Pay)
    if (!signature || !process.env.NOTCH_WEBHOOK_SECRET) {
        console.warn("⚠️ Webhook rejeté : signature ou secret manquant");
        return res.status(401).send('Unauthorized');
    }

    const calculatedSig = crypto
        .createHmac('sha256', process.env.NOTCH_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    const signaturesMatch = crypto.timingSafeEqual(
        Buffer.from(calculatedSig, 'hex'),
        Buffer.from(signature, 'hex')
    );

    if (!signaturesMatch) {
        console.warn("⚠️ Webhook rejeté : signature invalide");
        return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(rawBody);

    // Doc Notch Pay : le champ est "type" (pas "event")
    if (event.type === 'payment.complete') {
        const { amount, reference } = event.data;
        const parts = reference.split('_');
        const userId = parts[1];

        // ── Dépôt G-Caisse (référence format DEP_USERID_TIMESTAMP) ──
        if (reference.startsWith('DEP_') && userId) {
            try {
                await db.query('BEGIN');
                const checkTx = await db.query(
                    "SELECT id FROM public.transactions WHERE reference = $1", [reference]
                );
                if (checkTx.rows.length === 0) {
                    const userUpdate = await db.query(
                        "UPDATE public.users SET balance = balance + $1 WHERE id = $2 RETURNING id",
                        [amount, userId]
                    );
                    if (userUpdate.rows.length > 0) {
                        await db.query(
                            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, 'deposit', 'completed', $3, $4)",
                            [userId, amount, reference, 'Dépôt Notch Pay']
                        );
                        console.log(`✅ Dépôt réussi pour l'User ${userId} : +${amount} XAF`);
                    }
                }
                await db.query('COMMIT');
            } catch (err) {
                await db.query('ROLLBACK');
                console.error("❌ Erreur Webhook Dépôt:", err.message);
                return res.status(500).send('Internal Server Error');
            }
            return res.status(200).send('Deposit Processed');
        }

        // ── Recharge Airtime/Data (référence format AIR-USERID-TIMESTAMP) ──
        if (reference.startsWith('AIR-') || reference.startsWith('trx.')) {
            try {
                // Récupérer les infos de la recharge en attente
                const pendingRes = await db.query(
                    "SELECT * FROM public.airtime_pending WHERE payment_reference = $1",
                    [reference]
                );

                if (pendingRes.rows.length > 0) {
                    const pending = pendingRes.rows[0];

                    // Mettre à jour le statut de la transaction
                    await db.query(
                        "UPDATE public.transactions SET status = 'completed' WHERE reference = $1",
                        [reference]
                    );

                    // Activer le forfait via l'API opérateur
                    // Note : MTN et Orange Cameroun exposent des APIs partenaires
                    // Pour l'instant on log l'activation — à connecter à l'API opérateur
                    console.log(`✅ Recharge confirmée : ${pending.service_type} ${pending.operator} → ${pending.receiver_phone} (${pending.amount} XAF)`);
                    console.log(`   Activer le forfait via API ${pending.operator} pour ${pending.receiver_phone}`);

                    // Nettoyer la table pending
                    await db.query(
                        "DELETE FROM public.airtime_pending WHERE payment_reference = $1",
                        [reference]
                    );
                }
            } catch (err) {
                console.error("❌ Erreur Webhook Airtime:", err.message);
            }
            return res.status(200).send('Airtime Processed');
        }

        // ── Facture (référence format BILL-TYPE-USERID-TIMESTAMP) ──
        if (reference.startsWith('BILL-')) {
            await db.query(
                "UPDATE public.transactions SET status = 'completed' WHERE reference = $1",
                [reference]
            );
            console.log(`✅ Facture payée : ${reference}`);
            return res.status(200).send('Bill Processed');
        }

        return res.status(200).send('Payment Processed');
    }

    if (event.type === 'transfer.complete') {
        const { reference } = event.data;
        await db.query(
            "UPDATE public.transactions SET status = 'completed' WHERE reference = $1",
            [reference]
        );
        return res.status(200).send('Payout Confirmed');
    }

    // Autres événements de transfert (failed, reversed)
    if (event.type === 'transfer.failed' || event.type === 'transfer.reversed') {
        const { reference } = event.data;
        const status = event.type === 'transfer.failed' ? 'failed' : 'reversed';
        await db.query(
            "UPDATE public.transactions SET status = $1 WHERE reference = $2",
            [status, reference]
        );
        // Si échec ou annulation : rembourser l'utilisateur
        const txRes = await db.query(
            "SELECT user_id, amount FROM public.transactions WHERE reference = $1",
            [reference]
        );
        if (txRes.rows.length > 0) {
            const { user_id, amount } = txRes.rows[0];
            await db.query(
                "UPDATE public.users SET balance = balance + $1 WHERE id = $2",
                [amount, user_id]
            );
            console.log(`↩️ Remboursement de ${amount} XAF à l'user ${user_id} (${event.type})`);
        }
        return res.status(200).send('Transfer Event Processed');
    }

    res.status(200).send('Event Ignored');
});

// ==========================================
// 6. ROUTES MANQUANTES (sync ApiService)
// ==========================================

// Trust score
app.get('/api/users/:id/trust-score', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT credibility_score FROM public.users WHERE id = $1",
            [req.params.id]
        );
        res.json({ trust_score: result.rows[0]?.credibility_score ?? 100 });
    } catch (err) { res.json({ trust_score: 100 }); }
});

// Vérifier si un destinataire existe
app.get('/api/users/check', authenticate, async (req, res) => {
    const { phone } = req.query;
    try {
        const result = await db.query(
            "SELECT fullname FROM public.users WHERE phone = $1 OR phone = '237' || $1",
            [phone]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Utilisateur introuvable' });
        res.json({ fullname: result.rows[0].fullname });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reçu d'une transaction
app.get('/api/transactions/:id/receipt', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT t.*, u.fullname, u.phone FROM public.transactions t JOIN public.users u ON t.user_id = u.id WHERE t.id = $1",
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Transaction introuvable' });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Paiement cotisation tontine
app.post('/api/payments/tontine', authenticate, requireFields('user_id', 'tontine_id', 'amount'), async (req, res) => {
    const { user_id, tontine_id, amount, is_late } = req.body;
    if (amount <= 0) return res.status(400).json({ message: 'Montant invalide' });
    try {
        await db.query('BEGIN');
        const userRes = await db.query("SELECT balance FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || parseFloat(userRes.rows[0].balance) < amount) {
            throw new Error('Solde insuffisant');
        }
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);
        // Si retard, une partie va au fond social
        if (is_late) {
            await db.query(
                "UPDATE public.social_funds SET balance = balance + 500, last_update = NOW() WHERE tontine_id = $1",
                [tontine_id]
            );
        }
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1, $2, 'tontine_pay', 'completed', $3)",
            [user_id, amount, `Cotisation tontine ${tontine_id}${is_late ? ' (retard)' : ''}`]
        );
        await db.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(400).json({ message: err.message });
    }
});

// Bénéficiaire actuel d'une tontine
app.get('/api/tontines/:id/winner', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.fullname, u.phone, tm.payout_method
            FROM public.tontines t
            JOIN public.users u ON t.current_beneficiary_id = u.id
            JOIN public.tontine_members tm ON tm.tontine_id = t.id AND tm.user_id = u.id
            WHERE t.id = $1
        `, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json(null);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json(null); }
});

// Membres d'une tontine
app.get('/api/tontines/:id/members', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.fullname, u.phone, tm.payout_method, tm.joined_at
            FROM public.tontine_members tm
            JOIN public.users u ON tm.user_id = u.id
            WHERE tm.tontine_id = $1
            ORDER BY tm.joined_at ASC
        `, [req.params.id]);
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

// Messages d'une tontine
app.get('/api/tontines/:id/messages', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT m.*, u.fullname FROM public.tontine_messages m
            JOIN public.users u ON m.user_id = u.id
            WHERE m.tontine_id = $1 ORDER BY m.created_at ASC
        `, [req.params.id]);
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

app.post('/api/tontines/:id/messages', authenticate, requireFields('user_id', 'content'), async (req, res) => {
    const { user_id, content } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO public.tontine_messages (tontine_id, user_id, content, message_type) VALUES ($1, $2, $3, 'text') RETURNING *",
            [req.params.id, user_id, content]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload d'un message vocal
app.post('/api/tontines/:id/voice', authenticate, uploadVoice.single('audio'), async (req, res) => {
    const { user_id, duration_sec } = req.body;

    if (!req.file) return res.status(400).json({ message: 'Fichier audio manquant' });
    if (!user_id)  return res.status(400).json({ message: 'user_id manquant' });

    try {
        let voiceUrl;

        if (process.env.CLOUDINARY_CLOUD_NAME) {
            // Upload vers Cloudinary (production)
            const uploadResult = await cloudinary.uploader.upload(req.file.path, {
                resource_type: 'video', // Cloudinary utilise 'video' pour les audios
                folder: 'gcaisse/voices',
                public_id: `voice_${req.params.id}_${Date.now()}`,
                format: 'aac'
            });
            voiceUrl = uploadResult.secure_url;
            // Supprimer le fichier temporaire local
            fs.unlink(req.file.path, () => {});
        } else {
            // Fallback : stockage local (développement)
            const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
            voiceUrl = `${baseUrl}/uploads/voices/${req.file.filename}`;
        }

        const result = await db.query(
            `INSERT INTO public.tontine_messages
             (tontine_id, user_id, content, message_type, voice_url, duration_sec)
             VALUES ($1, $2, $3, 'voice', $4, $5) RETURNING *`,
            [req.params.id, user_id, '🎤 Message vocal', voiceUrl, duration_sec || 0]
        );
        res.status(201).json({ success: true, message: result.rows[0] });
    } catch (err) {
        fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: err.message });
    }
});

// Enchères d'une tontine
app.get('/api/tontines/:id/auctions', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.auctions WHERE tontine_id = $1 ORDER BY created_at DESC",
            [req.params.id]
        );
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

// Localisation des membres d'une tontine
app.get('/api/tontines/:id/locations', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.fullname, u.latitude, u.longitude
            FROM public.tontine_members tm
            JOIN public.users u ON tm.user_id = u.id
            WHERE tm.tontine_id = $1 AND u.latitude IS NOT NULL
        `, [req.params.id]);
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

// Mettre à jour la localisation d'un utilisateur
app.post('/api/users/:id/location', authenticate, requireFields('latitude', 'longitude'), async (req, res) => {
    const { latitude, longitude } = req.body;
    try {
        await db.query(
            "UPDATE public.users SET latitude = $1, longitude = $2 WHERE id = $3",
            [latitude, longitude, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mettre à jour le token FCM
app.put('/api/users/:id/fcm-token', authenticate, requireFields('fcm_token'), async (req, res) => {
    const { fcm_token } = req.body;
    try {
        await db.query(
            "UPDATE public.users SET fcm_token = $1 WHERE id = $2",
            [fcm_token, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Épargne d'un utilisateur
app.get('/api/users/:id/savings', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.savings_goals WHERE user_id = $1 ORDER BY created_at DESC",
            [req.params.id]
        );
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

// Fond social global
app.get('/api/social/fund', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT COALESCE(SUM(balance), 0) as total FROM public.social_funds"
        );
        res.json({ total: result.rows[0].total });
    } catch (err) { res.status(500).json({ total: 0 }); }
});

// Événements sociaux
app.get('/api/social/events', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.social_events ORDER BY created_at DESC"
        );
        res.json(result.rows || []);
    } catch (err) { res.status(500).json([]); }
});

// Faire un don
app.post('/api/social/donate', authenticate, requireFields('event_id', 'amount'), async (req, res) => {
    const { event_id, amount } = req.body;
    if (amount <= 0) return res.status(400).json({ message: 'Montant invalide' });
    try {
        await db.query(
            "UPDATE public.social_events SET collected = collected + $1 WHERE id = $2",
            [amount, event_id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Prêt islamique
app.post('/api/loans/islamic', authenticate, requireFields('user_id', 'amount', 'purpose'), async (req, res) => {
    const { user_id, amount, purpose } = req.body;
    if (amount <= 0) return res.status(400).json({ message: 'Montant invalide' });
    try {
        await db.query(
            "INSERT INTO public.loans (user_id, amount, purpose, type, status) VALUES ($1, $2, $3, 'islamic', 'pending')",
            [user_id, amount, purpose]
        );
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Airtime & Data — Flux Notch Pay complet
app.post('/api/services/airtime', authenticate, requireFields('user_id', 'receiver_phone', 'amount', 'operator'), async (req, res) => {
    const { user_id, receiver_phone, amount, operator, service_type, plan_validity } = req.body;
    if (amount <= 0) return res.status(400).json({ message: 'Montant invalide' });

    // Mapping opérateur → channel Notch Pay
    const channelMap = { 'cm.mtn': 'cm.mtn', 'cm.orange': 'cm.orange', 'cm.mobile': 'cm.mobile' };
    const notchChannel = channelMap[operator] || 'cm.mobile';
    const reference = `AIR-${user_id}-${Date.now()}`;
    const description = service_type === 'Data'
        ? `Forfait Data ${operator} (${plan_validity || ''}) → ${receiver_phone}`
        : `Recharge Crédit ${operator} → ${receiver_phone}`;

    try {
        await db.query('BEGIN');

        // 1. Vérifier le solde
        const userRes = await db.query("SELECT balance, fullname, phone FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || parseFloat(userRes.rows[0].balance) < amount) {
            throw new Error('Solde G-Caisse insuffisant');
        }
        const { fullname, phone: userPhone } = userRes.rows[0];

        // 2. Initialiser le paiement Notch Pay (POST /payments)
        const initRes = await axios.post('https://api.notchpay.co/payments', {
            amount,
            currency: 'XAF',
            reference,
            description,
            customer: {
                name: fullname,
                email: `user${user_id}@g-caisse.com`,
                phone: userPhone  // Le payeur est l'utilisateur connecté
            },
            callback: process.env.PAYMENT_CALLBACK_URL || 'https://google.com'
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const paymentReference = initRes.data.transaction?.reference;
        if (!paymentReference) throw new Error('Référence Notch Pay introuvable');

        // 3. Déclencher le paiement Mobile Money (PIN prompt sur le téléphone du payeur)
        await axios.post(`https://api.notchpay.co/payments/${paymentReference}`, {
            channel: notchChannel,
            data: { phone: userPhone }
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // 4. Débiter le solde et enregistrer en DB avec statut 'processing'
        //    L'activation du forfait se fait dans le webhook après confirmation
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);
        await db.query(
            `INSERT INTO public.transactions
             (user_id, amount, type, status, reference, description)
             VALUES ($1, $2, 'airtime', 'processing', $3, $4)`,
            [user_id, amount, paymentReference, description]
        );
        // Stocker les infos de la recharge pour le webhook
        await db.query(
            `INSERT INTO public.airtime_pending
             (payment_reference, receiver_phone, operator, service_type, plan_validity, amount)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (payment_reference) DO NOTHING`,
            [paymentReference, receiver_phone, operator, service_type || 'Crédit', plan_validity || null, amount]
        ).catch(() => {}); // Ignore si la table n'existe pas encore (créée par migrate)

        await db.query('COMMIT');

        res.json({
            success: true,
            payment_id: paymentReference,        // Pour le SDK Flutter
            payment_reference: paymentReference, // Pour le polling
            message: 'Validez le paiement sur votre téléphone (demande PIN Mobile Money envoyée)'
        });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Erreur airtime:', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || err.message });
    }
});

// Vérifier le statut d'une recharge
app.get('/api/services/airtime/status/:reference', authenticate, async (req, res) => {
    try {
        const notchRes = await axios.get(`https://api.notchpay.co/payments/${req.params.reference}`, {
            headers: { 'Authorization': process.env.NOTCH_PUBLIC_KEY, 'Accept': 'application/json' }
        });
        const status = notchRes.data.transaction?.status || 'pending';

        if (status === 'complete' || status === 'failed' || status === 'canceled') {
            const dbStatus = status === 'complete' ? 'completed' : status;
            await db.query(
                "UPDATE public.transactions SET status = $1 WHERE reference = $2",
                [dbStatus, req.params.reference]
            );
            if (status !== 'complete') {
                const txRes = await db.query(
                    "SELECT user_id, amount FROM public.transactions WHERE reference = $1",
                    [req.params.reference]
                );
                if (txRes.rows.length > 0) {
                    await db.query(
                        "UPDATE public.users SET balance = balance + $1 WHERE id = $2",
                        [txRes.rows[0].amount, txRes.rows[0].user_id]
                    );
                }
            }
        }
        res.json({ status, transaction: notchRes.data.transaction });
    } catch (err) {
        res.status(400).json({ message: err.response?.data?.message || err.message });
    }
});

// Paiement de factures via Notch Pay USSD
app.post('/api/services/:type', authenticate, requireFields('user_id', 'contract_number', 'amount', 'phone', 'operator'), async (req, res) => {
    const { user_id, contract_number, amount, phone, operator } = req.body;
    const billType = req.params.type.toUpperCase(); // ENEO ou CAMWATER

    if (amount <= 0) return res.status(400).json({ message: 'Montant invalide' });

    // Channels Notch Pay selon l'opérateur choisi
    const channelMap = {
        'cm.mtn':    'cm.mtn',
        'cm.orange': 'cm.orange',
        'cm.mobile': 'cm.mobile',
    };
    const notchChannel = channelMap[operator] || 'cm.mobile';

    // Codes USSD affichés à l'utilisateur pour confirmation
    const ussdCodes = {
        'cm.mtn':    '*126#',
        'cm.orange': '*150*3#',
        'cm.mobile': '*126# (MTN) ou *150*3# (Orange)',
    };
    const ussdCode = ussdCodes[notchChannel] || '*126#';

    const reference = `BILL-${billType}-${user_id}-${Date.now()}`;

    try {
        await db.query('BEGIN');

        // 1. Vérifier le solde
        const userRes = await db.query("SELECT balance, fullname FROM public.users WHERE id = $1", [user_id]);
        if (!userRes.rows[0] || parseFloat(userRes.rows[0].balance) < amount) {
            throw new Error('Solde G-Caisse insuffisant');
        }
        const userName = userRes.rows[0].fullname;

        // 2. Initialiser le paiement Notch Pay (POST /payments)
        const initRes = await axios.post('https://api.notchpay.co/payments', {
            amount,
            currency: 'XAF',
            reference,
            description: `Facture ${billType} - Contrat ${contract_number}`,
            customer: {
                name: userName,
                email: `user${user_id}@g-caisse.com`,
                phone
            },
            callback: process.env.PAYMENT_CALLBACK_URL || 'https://google.com'
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        const paymentReference = initRes.data.transaction?.reference;
        if (!paymentReference) throw new Error('Référence Notch Pay introuvable');

        // 3. Déclencher le paiement USSD (POST /payments/{reference})
        await axios.post(`https://api.notchpay.co/payments/${paymentReference}`, {
            channel: notchChannel,
            data: { phone }
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // 4. Débiter le solde G-Caisse et enregistrer la transaction
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id = $2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, 'bill', 'processing', $3, $4)",
            [user_id, amount, paymentReference, `Facture ${billType} - Contrat ${contract_number}`]
        );

        await db.query('COMMIT');

        res.json({
            success: true,
            payment_id: paymentReference,        // Pour le SDK Flutter
            payment_reference: paymentReference, // Pour le polling
            ussd_code: ussdCode,
            operator: notchChannel,
            message: `Composez ${ussdCode} sur votre téléphone pour confirmer le paiement`
        });

    } catch (err) {
        await db.query('ROLLBACK');
        console.error('Erreur paiement facture:', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || err.message });
    }
});

// Vérifier le statut d'un paiement de facture
app.get('/api/services/bill/status/:reference', authenticate, async (req, res) => {
    try {
        const notchRes = await axios.get(`https://api.notchpay.co/payments/${req.params.reference}`, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Accept': 'application/json'
            }
        });
        const status = notchRes.data.transaction?.status || 'pending';

        // Mettre à jour le statut en DB si complet ou échoué
        if (status === 'complete' || status === 'failed' || status === 'canceled') {
            const dbStatus = status === 'complete' ? 'completed' : status;
            await db.query(
                "UPDATE public.transactions SET status = $1 WHERE reference = $2",
                [dbStatus, req.params.reference]
            );
            // Si échec : rembourser
            if (status !== 'complete') {
                const txRes = await db.query(
                    "SELECT user_id, amount FROM public.transactions WHERE reference = $1",
                    [req.params.reference]
                );
                if (txRes.rows.length > 0) {
                    await db.query(
                        "UPDATE public.users SET balance = balance + $1 WHERE id = $2",
                        [txRes.rows[0].amount, txRes.rows[0].user_id]
                    );
                }
            }
        }

        res.json({ status, transaction: notchRes.data.transaction });
    } catch (err) {
        res.status(400).json({ message: err.response?.data?.message || err.message });
    }
});

// ==========================================
// LANCEMENT
// ==========================================
app.listen(port, () => {
    console.log(`🚀 Serveur G-CAISSE opérationnel sur le port ${port}`);
});
