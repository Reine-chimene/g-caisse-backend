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

const app = express();
const port = process.env.PORT || 3000;
const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_g_caisse';

// ==========================================
// CONFIGURATIONS
// ==========================================
if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key:    process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
    });
}

const VOICE_DIR = path.join(__dirname, 'uploads', 'voices');
if (!fs.existsSync(VOICE_DIR)) fs.mkdirSync(VOICE_DIR, { recursive: true });

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
        const allowed = ['audio/aac','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','application/octet-stream'];
        cb(null, allowed.includes(file.mimetype) || /\.(aac|mp3|m4a|ogg|wav|webm)$/i.test(file.originalname));
    }
});

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));

app.use((req, res, next) => {
    if (req.path === '/api/webhook') return next();
    bodyParser.json()(req, res, next);
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const authenticate = (req, res, next) => {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token manquant' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        return res.status(403).json({ message: 'Token invalide ou expiré' });
    }
};

const requireFields = (...fields) => (req, res, next) => {
    const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
    if (missing.length > 0) return res.status(400).json({ message: `Champs manquants : ${missing.join(', ')}` });
    next();
};

// ==========================================
// INITIALISATION BASE DE DONNÉES
// ==========================================
const initDb = async () => {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS public.users (
            id SERIAL PRIMARY KEY, fullname TEXT, phone TEXT UNIQUE,
            pincode_hash TEXT, balance DECIMAL DEFAULT 0,
            credibility_score INTEGER DEFAULT 50,
            latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
            fcm_token TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.tontines (
            id SERIAL PRIMARY KEY, name TEXT, admin_id INTEGER REFERENCES public.users(id),
            frequency TEXT, amount_to_pay DECIMAL, commission_rate DECIMAL DEFAULT 0,
            status TEXT DEFAULT 'active',
            deadline_time TEXT DEFAULT '23:59',
            deadline_day INTEGER DEFAULT 28,
            has_caisse_fund BOOLEAN DEFAULT false,
            caisse_fund_amount DECIMAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.tontine_members (
            id SERIAL PRIMARY KEY, tontine_id INTEGER REFERENCES public.tontines(id),
            user_id INTEGER REFERENCES public.users(id),
            caisse_fund_paid DECIMAL DEFAULT 0,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tontine_id, user_id)
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.transactions (
            id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES public.users(id),
            amount DECIMAL, type TEXT, status TEXT, reference TEXT,
            description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.tontine_payments (
            id SERIAL PRIMARY KEY, tontine_id INTEGER REFERENCES public.tontines(id),
            user_id INTEGER REFERENCES public.users(id),
            amount DECIMAL, is_late BOOLEAN DEFAULT false,
            paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.messages (
            id SERIAL PRIMARY KEY, tontine_id INTEGER REFERENCES public.tontines(id),
            user_id INTEGER REFERENCES public.users(id),
            content TEXT, message_type TEXT DEFAULT 'text',
            voice_url TEXT, duration_sec INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.social_events (
            id SERIAL PRIMARY KEY,
            tontine_id INTEGER REFERENCES public.tontines(id),
            event_type TEXT NOT NULL,
            description TEXT,
            beneficiary_name TEXT,
            target_amount DECIMAL DEFAULT 0,
            collected DECIMAL DEFAULT 0,
            created_by INTEGER REFERENCES public.users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.social_donations (
            id SERIAL PRIMARY KEY,
            event_id INTEGER REFERENCES public.social_events(id),
            user_id INTEGER REFERENCES public.users(id),
            amount DECIMAL,
            donated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.loans (
            id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES public.users(id),
            amount DECIMAL, purpose TEXT, status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Classement des membres : qui reçoit quel mois/cycle
        await db.query(`CREATE TABLE IF NOT EXISTS public.tontine_schedule (
            id SERIAL PRIMARY KEY,
            tontine_id INTEGER REFERENCES public.tontines(id),
            user_id INTEGER REFERENCES public.users(id),
            cycle_number INTEGER NOT NULL,
            scheduled_month INTEGER,
            scheduled_year INTEGER,
            has_received BOOLEAN DEFAULT false,
            received_at TIMESTAMP,
            payout_amount DECIMAL DEFAULT 0,
            UNIQUE(tontine_id, cycle_number)
        )`);
        // Historique des paiements groupés (cagnotte envoyée au bénéficiaire)
        await db.query(`CREATE TABLE IF NOT EXISTS public.tontine_payouts (
            id SERIAL PRIMARY KEY,
            tontine_id INTEGER REFERENCES public.tontines(id),
            beneficiary_id INTEGER REFERENCES public.users(id),
            cycle_number INTEGER,
            total_amount DECIMAL,
            payout_method TEXT DEFAULT 'wallet',
            paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Ajouter les colonnes manquantes si la table existe déjà
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS deadline_time TEXT DEFAULT '23:59'`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS deadline_day INTEGER DEFAULT 28`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS has_caisse_fund BOOLEAN DEFAULT false`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS caisse_fund_amount DECIMAL DEFAULT 0`);
        // Colonnes manquantes dans tontine_members
        await db.query(`ALTER TABLE public.tontine_members ADD COLUMN IF NOT EXISTS caisse_fund_paid DECIMAL DEFAULT 0`);
        console.log("✅ Base de données prête.");
    } catch (err) {
        console.error("❌ Erreur DB:", err.message);
    }
};
initDb();

// ==========================================
// ROUTES DE BASE
// ==========================================
app.get('/', (req, res) => {
    res.send('<h1 style="color:#FF7900;text-align:center;">🚀 SERVEUR G-CAISSE LIVE OPERATIONAL</h1>');
});

// ==========================================
// AUTHENTIFICATION
// ==========================================

// POST /api/users  (inscription — appelé par registerUser dans api_service)
app.post('/api/users', requireFields('fullname', 'phone', 'pincode'), async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const pincode_hash = await bcrypt.hash(String(pincode), SALT_ROUNDS);
        const result = await db.query(
            "INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id, fullname, phone",
            [fullname, phone, pincode_hash]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ message: "Ce numéro est déjà enregistré" });
        res.status(500).json({ message: "Erreur lors de l'inscription" });
    }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;
    if (!phone || !pincode) return res.status(400).json({ message: "Téléphone et PIN requis" });
    try {
        const result = await db.query("SELECT * FROM public.users WHERE phone = $1", [phone]);
        if (result.rows.length === 0) return res.status(401).json({ message: "Utilisateur non trouvé" });

        const user = result.rows[0];
        const isValid = await bcrypt.compare(String(pincode), user.pincode_hash);
        if (!isValid) return res.status(401).json({ message: "Code PIN incorrect" });

        const token = jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
        delete user.pincode_hash;
        res.json({ ...user, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/users/reset-pin
app.post('/api/users/reset-pin', requireFields('phone', 'new_pin'), async (req, res) => {
    const { phone, new_pin } = req.body;
    try {
        const pincode_hash = await bcrypt.hash(String(new_pin), SALT_ROUNDS);
        const result = await db.query(
            "UPDATE public.users SET pincode_hash = $1 WHERE phone = $2 RETURNING id",
            [pincode_hash, phone]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        res.json({ message: "PIN réinitialisé avec succès" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// PUT /api/users/:id
app.put('/api/users/:id', authenticate, async (req, res) => {
    const { fullname, phone } = req.body;
    try {
        await db.query("UPDATE public.users SET fullname=$1, phone=$2 WHERE id=$3", [fullname, phone, req.params.id]);
        res.json({ message: "Profil mis à jour" });
    } catch (err) {
        res.status(500).json({ message: "Erreur mise à jour" });
    }
});

// GET /api/users/:id/balance
app.get('/api/users/:id/balance', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT balance FROM public.users WHERE id=$1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        res.json({ balance: result.rows[0].balance });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/users/:id/trust-score
app.get('/api/users/:id/trust-score', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT credibility_score FROM public.users WHERE id=$1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        res.json({ trust_score: result.rows[0].credibility_score });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/users/:id/transactions
app.get('/api/users/:id/transactions', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// PUT /api/users/:id/fcm-token
app.put('/api/users/:id/fcm-token', authenticate, async (req, res) => {
    try {
        await db.query("UPDATE public.users SET fcm_token=$1 WHERE id=$2", [req.body.fcm_token, req.params.id]);
        res.json({ message: "Token FCM mis à jour" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/users/:id/location
app.post('/api/users/:id/location', authenticate, async (req, res) => {
    const { latitude, longitude } = req.body;
    try {
        await db.query("UPDATE public.users SET latitude=$1, longitude=$2 WHERE id=$3", [latitude, longitude, req.params.id]);
        res.json({ message: "Localisation mise à jour" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/users/check?phone=&operator=
app.get('/api/users/check', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT fullname FROM public.users WHERE phone=$1", [req.query.phone]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        res.json({ fullname: result.rows[0].fullname });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/users/:id/savings
app.get('/api/users/:id/savings', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT SUM(amount) as current_amount FROM public.transactions WHERE user_id=$1 AND type='saving'",
            [req.params.id]
        );
        res.json([{ current_amount: result.rows[0].current_amount || 0 }]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// TONTINES
// ==========================================

// GET /api/tontines?user_id=X
app.get('/api/tontines', authenticate, async (req, res) => {
    try {
        const userId = req.query.user_id;
        let result;
        if (userId) {
            // Tontines où l'utilisateur est admin OU membre
            result = await db.query(`
                SELECT DISTINCT t.*, 
                    (SELECT COUNT(*) FROM public.tontine_members tm WHERE tm.tontine_id = t.id) as member_count
                FROM public.tontines t
                LEFT JOIN public.tontine_members tm ON tm.tontine_id = t.id
                WHERE t.status = 'active' AND (t.admin_id = $1 OR tm.user_id = $1)
                ORDER BY t.created_at DESC
            `, [userId]);
        } else {
            result = await db.query(`
                SELECT t.*, 
                    (SELECT COUNT(*) FROM public.tontine_members tm WHERE tm.tontine_id = t.id) as member_count
                FROM public.tontines t
                WHERE t.status = 'active' ORDER BY t.created_at DESC
            `);
        }
        res.json(result.rows);
    } catch (err) {
        console.error("Erreur tontines:", err.message);
        res.status(500).json({ message: "Erreur lors de la récupération des tontines" });
    }
});

// POST /api/tontines
app.post('/api/tontines', authenticate, requireFields('name', 'admin_id', 'frequency', 'amount'), async (req, res) => {
    const { name, admin_id, frequency, amount, commission_rate,
            deadline_time, deadline_day, has_caisse_fund, caisse_fund_amount } = req.body;
    try {
        const result = await db.query(`
            INSERT INTO public.tontines
              (name, admin_id, frequency, amount_to_pay, commission_rate, status,
               deadline_time, deadline_day, has_caisse_fund, caisse_fund_amount)
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9) RETURNING *
        `, [name, admin_id, frequency, amount, commission_rate || 0,
            deadline_time || '23:59', deadline_day || 28,
            has_caisse_fund || false, caisse_fund_amount || 0]);

        // Ajouter l'admin comme premier membre
        await db.query(
            "INSERT INTO public.tontine_members (tontine_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [result.rows[0].id, admin_id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Erreur création tontine:", err.message, err.detail, err.code);
        res.status(500).json({
            message: "Échec de la création",
            error: err.message,
            detail: err.detail,
            code: err.code
        });
    }
});

// PUT /api/tontines/:id
app.put('/api/tontines/:id', authenticate, async (req, res) => {
    const { name, frequency, amount_to_pay, commission_rate } = req.body;
    try {
        const result = await db.query(`
            UPDATE public.tontines SET name=COALESCE($1,name), frequency=COALESCE($2,frequency),
            amount_to_pay=COALESCE($3,amount_to_pay), commission_rate=COALESCE($4,commission_rate)
            WHERE id=$5 RETURNING *
        `, [name, frequency, amount_to_pay, commission_rate, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Tontine non trouvée" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur mise à jour" });
    }
});

// GET /api/tontines/:id/members
app.get('/api/tontines/:id/members', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.fullname, u.phone, u.credibility_score, tm.joined_at
            FROM public.tontine_members tm
            JOIN public.users u ON u.id = tm.user_id
            WHERE tm.tontine_id = $1
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/tontines/:id/winner  (bénéficiaire du tour actuel)
app.get('/api/tontines/:id/winner', authenticate, async (req, res) => {
    try {
        // Le gagnant = membre qui n'a pas encore reçu le pot, dans l'ordre d'inscription
        const result = await db.query(`
            SELECT u.id, u.fullname, u.phone, 'Compte G-Caisse' as payout_method
            FROM public.tontine_members tm
            JOIN public.users u ON u.id = tm.user_id
            WHERE tm.tontine_id = $1
            ORDER BY tm.joined_at ASC LIMIT 1
        `, [req.params.id]);
        if (result.rows.length === 0) return res.json(null);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/tontines/:id/locations
app.get('/api/tontines/:id/locations', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.fullname, u.latitude, u.longitude
            FROM public.tontine_members tm
            JOIN public.users u ON u.id = tm.user_id
            WHERE tm.tontine_id = $1 AND u.latitude IS NOT NULL
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/payments/tontine
app.post('/api/payments/tontine', authenticate, requireFields('user_id', 'tontine_id', 'amount'), async (req, res) => {
    const { user_id, tontine_id, amount, is_late } = req.body;
    try {
        await db.query('BEGIN');
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.tontine_payments (tontine_id, user_id, amount, is_late) VALUES ($1,$2,$3,$4)",
            [tontine_id, user_id, amount, is_late || false]
        );
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'tontine_pay','completed','Cotisation tontine')",
            [user_id, amount]
        );
        // Mise à jour du score de crédibilité
        // +2 si paiement à temps, -5 si en retard (min 0, max 100)
        if (is_late) {
            await db.query(
                "UPDATE public.users SET credibility_score = GREATEST(0, credibility_score - 5) WHERE id=$1",
                [user_id]
            );
        } else {
            await db.query(
                "UPDATE public.users SET credibility_score = LEAST(100, credibility_score + 2) WHERE id=$1",
                [user_id]
            );
        }
        await db.query('COMMIT');
        res.json({ message: "Paiement effectué" });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ message: "Erreur paiement" });
    }
});

// POST /api/payments/caisse  (paiement fond de caisse)
app.post('/api/payments/caisse', authenticate, requireFields('user_id', 'tontine_id', 'amount'), async (req, res) => {
    const { user_id, tontine_id, amount } = req.body;
    try {
        await db.query('BEGIN');
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "UPDATE public.tontine_members SET caisse_fund_paid = caisse_fund_paid + $1 WHERE tontine_id=$2 AND user_id=$3",
            [amount, tontine_id, user_id]
        );
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'caisse_fund','completed','Fond de caisse tontine')",
            [user_id, amount]
        );
        await db.query('COMMIT');
        res.json({ message: "Fond de caisse payé" });
    } catch (err) {
        await db.query('ROLLBACK');
        res.status(500).json({ message: "Erreur paiement fond de caisse" });
    }
});

// POST /api/tontines/:id/auto-debit  (débit automatique des membres en retard)
app.post('/api/tontines/:id/auto-debit', authenticate, async (req, res) => {
    const tontineId = req.params.id;
    try {
        const tontineResult = await db.query("SELECT * FROM public.tontines WHERE id=$1", [tontineId]);
        if (!tontineResult.rows.length) return res.status(404).json({ message: "Tontine non trouvée" });
        const tontine = tontineResult.rows[0];

        if (req.user.id !== tontine.admin_id) {
            return res.status(403).json({ message: "Seul l'admin peut déclencher le débit automatique" });
        }

        const baseAmount = parseFloat(tontine.amount_to_pay);
        const penalty = 500;
        const totalToPay = baseAmount + penalty;

        const membersResult = await db.query(`
            SELECT tm.user_id, u.fullname, u.balance
            FROM public.tontine_members tm
            JOIN public.users u ON u.id = tm.user_id
            WHERE tm.tontine_id = $1
            AND tm.user_id NOT IN (
                SELECT user_id FROM public.tontine_payments
                WHERE tontine_id = $1
                AND paid_at >= date_trunc('month', NOW())
            )
        `, [tontineId]);

        const debited = [];
        const failed = [];

        for (const member of membersResult.rows) {
            if (parseFloat(member.balance) >= totalToPay) {
                try {
                    await db.query('BEGIN');
                    await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [totalToPay, member.user_id]);
                    await db.query(
                        "INSERT INTO public.tontine_payments (tontine_id, user_id, amount, is_late) VALUES ($1,$2,$3,true)",
                        [tontineId, member.user_id, totalToPay]
                    );
                    await db.query(
                        "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'tontine_pay','completed','Cotisation + amende (débit auto)')",
                        [member.user_id, totalToPay]
                    );
                    await db.query(
                        "UPDATE public.users SET credibility_score = GREATEST(0, credibility_score - 5) WHERE id=$1",
                        [member.user_id]
                    );
                    await db.query('COMMIT');
                    debited.push(member.fullname);
                } catch (e) {
                    await db.query('ROLLBACK').catch(() => {});
                    failed.push(member.fullname);
                }
            } else {
                failed.push(`${member.fullname} (solde insuffisant)`);
            }
        }

        res.json({ message: "Débit automatique effectué", debited, failed,
            total_debited: debited.length, total_failed: failed.length });
    } catch (err) {
        console.error("Erreur auto-débit:", err.message);
        res.status(500).json({ message: "Erreur auto-débit" });
    }
});

// GET /api/tontines/:id/member-status/:userId
app.get('/api/tontines/:id/member-status/:userId', authenticate, async (req, res) => {
    const { id: tontineId, userId } = req.params;
    try {
        const tontineResult = await db.query("SELECT * FROM public.tontines WHERE id=$1", [tontineId]);
        if (!tontineResult.rows.length) return res.status(404).json({ message: "Tontine non trouvée" });
        const t = tontineResult.rows[0];

        const cotisationPaid = await db.query(`
            SELECT COUNT(*) as count FROM public.tontine_payments
            WHERE tontine_id=$1 AND user_id=$2
            AND paid_at >= date_trunc('month', NOW())
        `, [tontineId, userId]);

        const caissePaid = await db.query(
            "SELECT COALESCE(caisse_fund_paid, 0) as paid FROM public.tontine_members WHERE tontine_id=$1 AND user_id=$2",
            [tontineId, userId]
        );

        const hasPaidCotisation = parseInt(cotisationPaid.rows[0].count) > 0;
        const caisseFundPaid = parseFloat(caissePaid.rows[0]?.paid || 0);
        const caisseFundRequired = parseFloat(t.caisse_fund_amount || 0);
        const hasCaisseFund = t.has_caisse_fund;
        const isCaisseComplete = !hasCaisseFund || caisseFundPaid >= caisseFundRequired;
        const isRegular = hasPaidCotisation && isCaisseComplete;

        res.json({
            has_paid_cotisation: hasPaidCotisation,
            caisse_fund_paid: caisseFundPaid,
            caisse_fund_required: caisseFundRequired,
            has_caisse_fund: hasCaisseFund,
            is_caisse_complete: isCaisseComplete,
            is_regular: isRegular,
            can_borrow: isRegular,
            deadline_time: t.deadline_time,
            deadline_day: t.deadline_day,
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// CLASSEMENT & CAGNOTTE
// ==========================================

// GET /api/tontines/:id/schedule  (classement des membres)
app.get('/api/tontines/:id/schedule', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT ts.*, u.fullname, u.phone,
                (SELECT COALESCE(SUM(tp.amount),0)
                 FROM public.tontine_payments tp
                 WHERE tp.tontine_id = ts.tontine_id
                 AND tp.paid_at >= date_trunc('month',
                     make_date(ts.scheduled_year, ts.scheduled_month, 1))
                 AND tp.paid_at < date_trunc('month',
                     make_date(ts.scheduled_year, ts.scheduled_month, 1)) + interval '1 month'
                ) as collected_this_cycle
            FROM public.tontine_schedule ts
            JOIN public.users u ON u.id = ts.user_id
            WHERE ts.tontine_id = $1
            ORDER BY ts.cycle_number ASC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/tontines/:id/schedule  (générer ou mettre à jour le classement)
app.post('/api/tontines/:id/schedule', authenticate, async (req, res) => {
    const tontineId = req.params.id;
    try {
        const tontine = await db.query("SELECT * FROM public.tontines WHERE id=$1", [tontineId]);
        if (!tontine.rows.length) return res.status(404).json({ message: "Tontine non trouvée" });
        if (req.user.id !== tontine.rows[0].admin_id) {
            return res.status(403).json({ message: "Seul l'admin peut gérer le classement" });
        }

        const members = await db.query(
            "SELECT user_id FROM public.tontine_members WHERE tontine_id=$1 ORDER BY joined_at ASC",
            [tontineId]
        );

        const now = new Date();
        let month = now.getMonth() + 1;
        let year  = now.getFullYear();

        // Supprimer l'ancien classement non reçu
        await db.query(
            "DELETE FROM public.tontine_schedule WHERE tontine_id=$1 AND has_received=false",
            [tontineId]
        );

        const inserted = [];
        for (let i = 0; i < members.rows.length; i++) {
            const cycleMonth = ((month - 1 + i) % 12) + 1;
            const cycleYear  = year + Math.floor((month - 1 + i) / 12);
            const cycleNum   = i + 1;

            // Ne pas écraser si déjà reçu
            const existing = await db.query(
                "SELECT id FROM public.tontine_schedule WHERE tontine_id=$1 AND user_id=$2",
                [tontineId, members.rows[i].user_id]
            );
            if (existing.rows.length === 0) {
                await db.query(`
                    INSERT INTO public.tontine_schedule
                      (tontine_id, user_id, cycle_number, scheduled_month, scheduled_year)
                    VALUES ($1,$2,$3,$4,$5)
                    ON CONFLICT (tontine_id, cycle_number) DO NOTHING
                `, [tontineId, members.rows[i].user_id, cycleNum, cycleMonth, cycleYear]);
                inserted.push(members.rows[i].user_id);
            }
        }
        res.json({ message: "Classement généré", count: inserted.length });
    } catch (err) {
        console.error("Erreur classement:", err.message);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/tontines/:id/cagnotte  (total des cotisations du cycle actuel)
app.get('/api/tontines/:id/cagnotte', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                COALESCE(SUM(tp.amount), 0) as total_collected,
                COUNT(DISTINCT tp.user_id) as payers_count,
                (SELECT COUNT(*) FROM public.tontine_members WHERE tontine_id=$1) as total_members,
                (SELECT amount_to_pay FROM public.tontines WHERE id=$1) as amount_per_member
            FROM public.tontine_payments tp
            WHERE tp.tontine_id = $1
            AND tp.paid_at >= date_trunc('month', NOW())
        `, [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/tontines/:id/payout  (envoyer la cagnotte au bénéficiaire)
app.post('/api/tontines/:id/payout', authenticate, requireFields('beneficiary_id', 'payout_method'), async (req, res) => {
    const tontineId = req.params.id;
    const { beneficiary_id, payout_method } = req.body;
    try {
        const tontine = await db.query("SELECT * FROM public.tontines WHERE id=$1", [tontineId]);
        if (!tontine.rows.length) return res.status(404).json({ message: "Tontine non trouvée" });
        if (req.user.id !== tontine.rows[0].admin_id) {
            return res.status(403).json({ message: "Seul l'admin peut envoyer la cagnotte" });
        }

        // Calculer le total du cycle actuel
        const cagnotte = await db.query(`
            SELECT COALESCE(SUM(amount), 0) as total
            FROM public.tontine_payments
            WHERE tontine_id=$1 AND paid_at >= date_trunc('month', NOW())
        `, [tontineId]);

        const total = parseFloat(cagnotte.rows[0].total);
        if (total <= 0) return res.status(400).json({ message: "Aucune cotisation collectée ce mois" });

        await db.query('BEGIN');

        // Créditer le bénéficiaire si paiement interne
        if (payout_method === 'wallet') {
            await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [total, beneficiary_id]);
        }

        // Enregistrer le paiement
        const cycleResult = await db.query(
            "SELECT COALESCE(MAX(cycle_number),0)+1 as next FROM public.tontine_payouts WHERE tontine_id=$1",
            [tontineId]
        );
        const cycleNum = cycleResult.rows[0].next;

        await db.query(`
            INSERT INTO public.tontine_payouts (tontine_id, beneficiary_id, cycle_number, total_amount, payout_method)
            VALUES ($1,$2,$3,$4,$5)
        `, [tontineId, beneficiary_id, cycleNum, total, payout_method]);

        // Marquer le bénéficiaire comme ayant reçu
        await db.query(`
            UPDATE public.tontine_schedule
            SET has_received=true, received_at=NOW(), payout_amount=$1
            WHERE tontine_id=$2 AND user_id=$3 AND has_received=false
        `, [total, tontineId, beneficiary_id]);

        // Transaction pour le bénéficiaire
        await db.query(`
            INSERT INTO public.transactions (user_id, amount, type, status, description)
            VALUES ($1,$2,'tontine_payout','completed','Cagnotte tontine reçue')
        `, [beneficiary_id, total]);

        await db.query('COMMIT');
        res.json({ message: "Cagnotte envoyée avec succès", total, beneficiary_id, payout_method });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error("Erreur payout:", err.message);
        res.status(500).json({ message: "Erreur envoi cagnotte" });
    }
});

// POST /api/tontines/:id/whatsapp-reminder  (envoyer rappels WhatsApp)
app.post('/api/tontines/:id/whatsapp-reminder', authenticate, async (req, res) => {
    const tontineId = req.params.id;
    try {
        const tontine = await db.query("SELECT * FROM public.tontines WHERE id=$1", [tontineId]);
        if (!tontine.rows.length) return res.status(404).json({ message: "Tontine non trouvée" });
        const t = tontine.rows[0];

        // Membres qui n'ont pas encore payé ce mois
        const unpaid = await db.query(`
            SELECT u.fullname, u.phone
            FROM public.tontine_members tm
            JOIN public.users u ON u.id = tm.user_id
            WHERE tm.tontine_id = $1
            AND tm.user_id NOT IN (
                SELECT user_id FROM public.tontine_payments
                WHERE tontine_id=$1 AND paid_at >= date_trunc('month', NOW())
            )
        `, [tontineId]);

        const messages = unpaid.rows.map(m => ({
            phone: m.phone,
            fullname: m.fullname,
            message: `Bonjour ${m.fullname} 👋\n\nRappel : La cotisation de la tontine *${t.name}* est due avant le *${t.deadline_day} du mois à ${t.deadline_time}*.\n\nMontant : *${t.amount_to_pay} FCFA*\n\nMerci de payer à temps pour éviter l'amende de 500 F. 🙏\n\n_G-Caisse_`,
            whatsapp_url: `https://wa.me/237${m.phone.replace(/^0/, '')}?text=${encodeURIComponent(`Bonjour ${m.fullname}, rappel cotisation tontine ${t.name} : ${t.amount_to_pay} FCFA avant le ${t.deadline_day} à ${t.deadline_time}. Merci !`)}`
        }));

        res.json({ message: "Rappels préparés", count: messages.length, reminders: messages });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// MESSAGERIE
// ==========================================

// GET /api/tontines/:id/messages
app.get('/api/tontines/:id/messages', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT m.*, u.fullname FROM public.messages m
            JOIN public.users u ON u.id = m.user_id
            WHERE m.tontine_id = $1 ORDER BY m.created_at ASC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/tontines/:id/messages
app.post('/api/tontines/:id/messages', authenticate, requireFields('user_id', 'content'), async (req, res) => {
    const { user_id, content } = req.body;
    try {
        const result = await db.query(
            "INSERT INTO public.messages (tontine_id, user_id, content, message_type) VALUES ($1,$2,$3,'text') RETURNING *",
            [req.params.id, user_id, content]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur envoi message" });
    }
});

// POST /api/tontines/:id/voice
app.post('/api/tontines/:id/voice', authenticate, uploadVoice.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Fichier audio manquant" });
    const { user_id, duration_sec } = req.body;
    try {
        let voice_url = `/uploads/voices/${req.file.filename}`;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            const upload = await cloudinary.uploader.upload(req.file.path, { resource_type: 'video', folder: 'voices' });
            voice_url = upload.secure_url;
            fs.unlinkSync(req.file.path);
        }
        const result = await db.query(
            "INSERT INTO public.messages (tontine_id, user_id, message_type, voice_url, duration_sec) VALUES ($1,$2,'voice',$3,$4) RETURNING *",
            [req.params.id, user_id, voice_url, duration_sec || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur upload vocal" });
    }
});

// ==========================================
// ENCHÈRES
// ==========================================

// GET /api/tontines/:id/auctions
app.get('/api/tontines/:id/auctions', authenticate, async (req, res) => {
    try {
        // Retourne les enchères actives pour cette tontine
        // Table auctions à créer si besoin, sinon retourne un exemple
        res.json([]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// FINANCE
// ==========================================

// POST /api/deposit
app.post('/api/deposit', authenticate, requireFields('amount', 'user_id', 'name'), async (req, res) => {
    const { amount, user_id, name, email, phone } = req.body;
    const reference = `DEP_${user_id}_${Date.now()}`;
    try {
        if (!process.env.NOTCH_PRIVATE_KEY) {
            console.error('[NOTCH] NOTCH_PRIVATE_KEY non configuré dans les variables d\'environnement');
            return res.status(500).json({ error: "Configuration paiement manquante", details: "NOTCH_PRIVATE_KEY non défini sur le serveur" });
        }
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount,
            currency: 'XAF',
            reference,
            callback: process.env.PAYMENT_CALLBACK_URL,
            customer: {
                name,
                email: email || `user${user_id}@g-caisse.com`,
                phone
            }
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.NOTCH_PRIVATE_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        // Notch Pay retourne l'URL dans transaction.payment_url ou authorization_url selon la version
        const data = response.data;
        const paymentUrl = data?.transaction?.payment_url
            || data?.authorization_url
            || data?.payment_url;

        if (!paymentUrl) {
            console.error('[NOTCH] Réponse inattendue:', JSON.stringify(data));
            return res.status(400).json({ error: "URL de paiement non reçue", details: data });
        }

        res.json({ success: true, payment_url: paymentUrl });
    } catch (err) {
        const errData = err.response?.data;
        console.error('[NOTCH DEPOSIT ERROR]', {
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: errData,
            message: err.message,
            headers: err.response?.headers
        });
        res.status(400).json({
            error: "Erreur Notch Pay",
            details: errData?.message || errData?.error || err.message,
            status: err.response?.status
        });
    }
});

// POST /api/payout
app.post('/api/payout', authenticate, requireFields('user_id', 'amount', 'phone', 'name'), async (req, res) => {
    const { user_id, amount, phone, name, channel } = req.body;
    try {
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        if (!process.env.NOTCH_PRIVATE_KEY) {
            return res.status(500).json({ message: "Configuration paiement manquante" });
        }
        const reference = `PAY_${user_id}_${Date.now()}`;
        const response = await axios.post('https://api.notchpay.co/transfers', {
            amount, currency: 'XAF', reference,
            destination: { channel: channel || 'cm.mobile', number: phone, name }
        }, { headers: { 'Authorization': `Bearer ${process.env.NOTCH_PRIVATE_KEY}`, 'Content-Type': 'application/json' } });

        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'withdrawal','completed',$3,'Retrait Mobile Money')",
            [user_id, amount, reference]
        );
        await db.query('COMMIT');
        res.json({ success: true, data: response.data });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(400).json({ message: err.response?.data?.message || "Erreur retrait" });
    }
});

// POST /api/transfer (transfert interne entre utilisateurs)
app.post('/api/transfer', authenticate, requireFields('sender_id', 'receiver_phone', 'amount'), async (req, res) => {
    const { sender_id, receiver_phone, amount } = req.body;
    try {
        await db.query('BEGIN');
        const sender = await db.query("SELECT balance FROM public.users WHERE id=$1", [sender_id]);
        if (sender.rows.length === 0 || sender.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        const receiver = await db.query("SELECT id FROM public.users WHERE phone=$1", [receiver_phone]);
        if (receiver.rows.length === 0) {
            await db.query('ROLLBACK');
            return res.status(404).json({ message: "Destinataire non trouvé" });
        }
        const receiverId = receiver.rows[0].id;
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, sender_id]);
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [amount, receiverId]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_out','completed','Transfert envoyé')", [sender_id, amount]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_in','completed','Transfert reçu')", [receiverId, amount]);
        await db.query('COMMIT');
        res.json({ message: "Transfert effectué" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur transfert" });
    }
});

// GET /api/transactions/:id/receipt
app.get('/api/transactions/:id/receipt', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.transactions WHERE id=$1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Transaction non trouvée" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// SERVICES (Airtime, Factures)
// ==========================================

// POST /api/services/airtime
app.post('/api/services/airtime', authenticate, requireFields('user_id', 'receiver_phone', 'amount', 'operator'), async (req, res) => {
    const { user_id, receiver_phone, amount, operator, service_type } = req.body;
    const reference = `AIR_${user_id}_${Date.now()}`;
    try {
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'airtime','completed',$3,$4)",
            [user_id, amount, reference, `Recharge ${operator} - ${receiver_phone}`]
        );
        await db.query('COMMIT');
        res.json({ success: true, reference, message: "Recharge effectuée" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur recharge" });
    }
});

// GET /api/services/airtime/status/:ref
app.get('/api/services/airtime/status/:ref', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.transactions WHERE reference=$1", [req.params.ref]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Transaction non trouvée" });
        res.json({ status: result.rows[0].status, reference: req.params.ref });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/services/:billType (eneo, camwater, etc.)
app.post('/api/services/:billType', authenticate, requireFields('user_id', 'amount'), async (req, res) => {
    const { user_id, amount, contract_number } = req.body;
    const { billType } = req.params;
    const reference = `BILL_${billType.toUpperCase()}_${user_id}_${Date.now()}`;
    try {
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'bill','completed',$3,$4)",
            [user_id, amount, reference, `Facture ${billType.toUpperCase()} - ${contract_number || ''}`]
        );
        await db.query('COMMIT');
        res.json({ success: true, reference, message: `Facture ${billType} payée` });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur paiement facture" });
    }
});

// GET /api/services/bill/status/:ref
app.get('/api/services/bill/status/:ref', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.transactions WHERE reference=$1", [req.params.ref]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Transaction non trouvée" });
        res.json({ status: result.rows[0].status, reference: req.params.ref });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// PRÊTS & SOCIAL
// ==========================================

// POST /api/loans/islamic
app.post('/api/loans/islamic', authenticate, requireFields('user_id', 'amount', 'purpose'), async (req, res) => {
    const { user_id, amount, purpose } = req.body;
    try {
        await db.query(
            "INSERT INTO public.loans (user_id, amount, purpose, status) VALUES ($1,$2,$3,'pending')",
            [user_id, amount, purpose]
        );
        res.json({ message: "Demande de prêt enregistrée" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/social/fund  (fonds global toutes tontines)
app.get('/api/social/fund', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT COALESCE(SUM(collected),0) as total FROM public.social_events");
        res.json({ total: result.rows[0].total });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/social/events  (tous les événements)
app.get('/api/social/events', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT se.*, u.fullname as creator_name
            FROM public.social_events se
            LEFT JOIN public.users u ON u.id = se.created_by
            ORDER BY se.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/tontines/:id/social/events  (événements d'une tontine)
app.get('/api/tontines/:id/social/events', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT se.*, u.fullname as creator_name,
                (SELECT COALESCE(SUM(sd.amount),0) FROM public.social_donations sd WHERE sd.event_id = se.id) as collected
            FROM public.social_events se
            LEFT JOIN public.users u ON u.id = se.created_by
            WHERE se.tontine_id = $1
            ORDER BY se.created_at DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/tontines/:id/social/events  (créer un événement dans une tontine)
app.post('/api/tontines/:id/social/events', authenticate,
    requireFields('event_type', 'description', 'target_amount', 'created_by'), async (req, res) => {
    const { event_type, description, target_amount, created_by, beneficiary_name } = req.body;
    try {
        const result = await db.query(`
            INSERT INTO public.social_events (tontine_id, event_type, description, target_amount, beneficiary_name, created_by)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
        `, [req.params.id, event_type, description, target_amount, beneficiary_name || '', created_by]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("Erreur création événement social:", err.message);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/social/donate  (faire un don à un événement)
app.post('/api/social/donate', authenticate, requireFields('event_id', 'amount', 'user_id'), async (req, res) => {
    const { event_id, amount, user_id } = req.body;
    try {
        await db.query('BEGIN');
        // Vérifier le solde
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (!userResult.rows.length || userResult.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ message: "Solde insuffisant" });
        }
        // Débiter le donateur
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        // Enregistrer le don
        await db.query(
            "INSERT INTO public.social_donations (event_id, user_id, amount) VALUES ($1,$2,$3)",
            [event_id, user_id, amount]
        );
        // Mettre à jour le total collecté
        await db.query("UPDATE public.social_events SET collected = collected + $1 WHERE id=$2", [amount, event_id]);
        // Transaction
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'social_donation','completed','Don solidarité')",
            [user_id, amount]
        );
        await db.query('COMMIT');
        res.json({ message: "Don enregistré" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// ADMIN
// ==========================================

// GET /api/admin/stats
app.get('/api/admin/stats', authenticate, async (req, res) => {
    try {
        const fees = await db.query("SELECT COALESCE(SUM(amount * 0.02),0) as total_fees FROM public.transactions WHERE status='completed'");
        const volume = await db.query("SELECT COALESCE(SUM(amount),0) as total_volume FROM public.transactions WHERE status='completed'");
        res.json({ total_fees: fees.rows[0].total_fees, total_volume: volume.rows[0].total_volume });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// WEBHOOK NOTCH PAY
// ==========================================
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-notch-signature'];
    const rawBody = req.body.toString();
    if (!signature || !process.env.NOTCH_WEBHOOK_SECRET) return res.status(401).send('Unauthorized');

    const calculatedSig = crypto.createHmac('sha256', process.env.NOTCH_WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (calculatedSig !== signature) return res.status(400).send('Invalid signature');

    const event = JSON.parse(rawBody);
    if (event.type === 'payment.complete') {
        const { amount, reference } = event.data;
        const userId = reference.split('_')[1];
        if (reference.startsWith('DEP_') && userId) {
            try {
                await db.query('BEGIN');
                await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [amount, userId]);
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'deposit','completed',$3,'Dépôt Notch Pay')",
                    [userId, amount, reference]
                );
                await db.query('COMMIT');
                return res.status(200).send('OK');
            } catch (err) {
                await db.query('ROLLBACK').catch(() => {});
                return res.status(500).send('DB Error');
            }
        }
    }
    res.status(200).send('Event ignored');
});

app.listen(port, () => console.log(`🚀 Serveur G-Caisse démarré sur le port ${port}`));
