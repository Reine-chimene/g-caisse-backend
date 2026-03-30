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
        // Commissions de la plateforme (2% prélevés lors du payout)
        await db.query(`CREATE TABLE IF NOT EXISTS public.platform_commissions (
            id SERIAL PRIMARY KEY,
            tontine_id INTEGER REFERENCES public.tontines(id),
            payout_id INTEGER REFERENCES public.tontine_payouts(id),
            gross_amount DECIMAL NOT NULL,
            commission_rate DECIMAL NOT NULL,
            commission_amount DECIMAL NOT NULL,
            net_amount DECIMAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Transferts en attente (OM↔MoMo, recharge, factures)
        await db.query(`CREATE TABLE IF NOT EXISTS public.pending_transfers (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES public.users(id),
            sender_phone TEXT NOT NULL,
            sender_operator TEXT NOT NULL,
            receiver_phone TEXT NOT NULL,
            receiver_operator TEXT NOT NULL,
            amount DECIMAL NOT NULL,
            payment_reference TEXT UNIQUE NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Dépôts par virement bancaire
        await db.query(`CREATE TABLE IF NOT EXISTS public.bank_deposits (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES public.users(id),
            amount DECIMAL NOT NULL,
            reference TEXT UNIQUE NOT NULL,
            bank_name TEXT,
            sender_name TEXT,
            status TEXT DEFAULT 'pending',
            admin_note TEXT,
            validated_by INTEGER REFERENCES public.users(id),
            validated_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        // Ajouter les colonnes manquantes si la table existe déjà
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS deadline_time TEXT DEFAULT '23:59'`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS deadline_day INTEGER DEFAULT 28`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS has_caisse_fund BOOLEAN DEFAULT false`);
        await db.query(`ALTER TABLE public.tontines ADD COLUMN IF NOT EXISTS caisse_fund_amount DECIMAL DEFAULT 0`);
        // Colonnes manquantes dans tontine_members
        await db.query(`ALTER TABLE public.tontine_members ADD COLUMN IF NOT EXISTS caisse_fund_paid DECIMAL DEFAULT 0`);
        // Corriger la contrainte frequency pour accepter toutes les valeurs de l'app
        await db.query("ALTER TABLE public.tontines DROP CONSTRAINT IF EXISTS tontines_frequency_check");
        await db.query("ALTER TABLE public.tontines ADD CONSTRAINT tontines_frequency_check CHECK (frequency::text = ANY(ARRAY['journalier','hebdo','mensuel','quinzaine','express']::text[]))");

        // === PARRAINAGE ===
        await db.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referral_code TEXT`);
        await db.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.referrals (
            id SERIAL PRIMARY KEY,
            referrer_id INTEGER REFERENCES public.users(id),
            referred_id INTEGER REFERENCES public.users(id),
            bonus_amount DECIMAL DEFAULT 500,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // === PREUVE VIDÉO ===
        await db.query(`ALTER TABLE public.tontine_payouts ADD COLUMN IF NOT EXISTS proof_video_url TEXT`);

        // Générer les codes de parrainage manquants
        const usersWithoutCode = await db.query("SELECT id FROM public.users WHERE referral_code IS NULL");
        for (const u of usersWithoutCode.rows) {
            const code = 'GC' + u.id.toString().padStart(5, '0');
            await db.query("UPDATE public.users SET referral_code=$1 WHERE id=$2", [code, u.id]);
        }

        console.log("✅ Base de données prête.");

        // === NOUVELLES FONCTIONNALITÉS ===

        // Demandes d'argent (Request Money)
        await db.query(`CREATE TABLE IF NOT EXISTS public.money_requests (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES public.users(id),
            receiver_id INTEGER REFERENCES public.users(id),
            amount DECIMAL NOT NULL,
            message TEXT,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            responded_at TIMESTAMP
        )`);

        // Partage de dépenses (Split Bill)
        await db.query(`CREATE TABLE IF NOT EXISTS public.split_bills (
            id SERIAL PRIMARY KEY,
            creator_id INTEGER REFERENCES public.users(id),
            title TEXT NOT NULL,
            total_amount DECIMAL NOT NULL,
            split_type TEXT DEFAULT 'equal',
            status TEXT DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.split_bill_participants (
            id SERIAL PRIMARY KEY,
            split_bill_id INTEGER REFERENCES public.split_bills(id),
            user_id INTEGER REFERENCES public.users(id),
            amount_owed DECIMAL NOT NULL,
            amount_paid DECIMAL DEFAULT 0,
            status TEXT DEFAULT 'pending',
            paid_at TIMESTAMP,
            UNIQUE(split_bill_id, user_id)
        )`);

        // Épargne automatique (Round-Up)
        await db.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS round_up_enabled BOOLEAN DEFAULT false`);
        await db.query(`ALTER TABLE public.users ADD COLUMN IF NOT EXISTS round_up_savings DECIMAL DEFAULT 0`);

        // Notifications
        await db.query(`CREATE TABLE IF NOT EXISTS public.notifications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES public.users(id),
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            type TEXT DEFAULT 'info',
            is_read BOOLEAN DEFAULT false,
            reference_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        // Paiements programmés
        await db.query(`CREATE TABLE IF NOT EXISTS public.scheduled_payments (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES public.users(id),
            payment_type TEXT NOT NULL,
            target_id INTEGER,
            amount DECIMAL NOT NULL,
            frequency TEXT DEFAULT 'monthly',
            next_payment_date DATE NOT NULL,
            is_active BOOLEAN DEFAULT true,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        console.log("✅ Nouvelles tables créées.");
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
    const { fullname, phone, pincode, referral_code } = req.body;
    try {
        const pincode_hash = await bcrypt.hash(String(pincode), SALT_ROUNDS);

        // Vérifier le code de parrainage
        let referrerId = null;
        if (referral_code) {
            const referrer = await db.query("SELECT id FROM public.users WHERE referral_code=$1", [referral_code.toUpperCase()]);
            if (referrer.rows.length > 0) referrerId = referrer.rows[0].id;
        }

        const result = await db.query(
            "INSERT INTO public.users (fullname, phone, pincode_hash, referred_by) VALUES ($1, $2, $3, $4) RETURNING id, fullname, phone",
            [fullname, phone, pincode_hash, referrerId]
        );
        const userId = result.rows[0].id;

        // Générer le code de parrainage unique
        const myReferralCode = 'GC' + userId.toString().padStart(5, '0');
        await db.query("UPDATE public.users SET referral_code=$1 WHERE id=$2", [myReferralCode, userId]);

        // Enregistrer le parrainage et créditer le bonus
        if (referrerId) {
            await db.query("INSERT INTO public.referrals (referrer_id, referred_id, status) VALUES ($1,$2,'completed')", [referrerId, userId]);
            await db.query("UPDATE public.users SET balance = balance + 500 WHERE id=$1", [referrerId]);
            await db.query(
                "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,500,'referral_bonus','completed','Bonus parrainage')",
                [referrerId]
            );
        }

        res.status(201).json({ ...result.rows[0], referral_code: myReferralCode });
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
        // Vérifier que l'utilisateur existe
        const userCheck = await db.query("SELECT id FROM public.users WHERE id=$1", [admin_id]);
        if (userCheck.rows.length === 0) {
            return res.status(400).json({ message: "Utilisateur invalide", error: `admin_id ${admin_id} non trouvé` });
        }
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
        applyRoundUp(user_id, amount);
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

        // Calcul de la commission plateforme
        const commissionRate = parseFloat(tontine.rows[0].commission_rate) || 1;
        const commissionAmount = Math.round(total * commissionRate / 100);
        const netAmount = total - commissionAmount;

        await db.query('BEGIN');

        // Créditer le bénéficiaire avec le montant net (après commission)
        if (payout_method === 'wallet') {
            await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [netAmount, beneficiary_id]);
        }

        // Enregistrer le paiement
        const cycleResult = await db.query(
            "SELECT COALESCE(MAX(cycle_number),0)+1 as next FROM public.tontine_payouts WHERE tontine_id=$1",
            [tontineId]
        );
        const cycleNum = cycleResult.rows[0].next;

        const payoutResult = await db.query(`
            INSERT INTO public.tontine_payouts (tontine_id, beneficiary_id, cycle_number, total_amount, payout_method)
            VALUES ($1,$2,$3,$4,$5) RETURNING id
        `, [tontineId, beneficiary_id, cycleNum, netAmount, payout_method]);

        // Enregistrer la commission
        await db.query(`
            INSERT INTO public.platform_commissions (tontine_id, payout_id, gross_amount, commission_rate, commission_amount, net_amount)
            VALUES ($1,$2,$3,$4,$5,$6)
        `, [tontineId, payoutResult.rows[0].id, total, commissionRate, commissionAmount, netAmount]);

        // Marquer le bénéficiaire comme ayant reçu
        await db.query(`
            UPDATE public.tontine_schedule
            SET has_received=true, received_at=NOW(), payout_amount=$1
            WHERE tontine_id=$2 AND user_id=$3 AND has_received=false
        `, [netAmount, tontineId, beneficiary_id]);

        // Transaction pour le bénéficiaire
        await db.query(`
            INSERT INTO public.transactions (user_id, amount, type, status, description)
            VALUES ($1,$2,'tontine_payout','completed','Cagnotte tontine reçue (après commission ${commissionRate}%)')
        `, [beneficiary_id, netAmount]);

        await db.query('COMMIT');
        res.json({ message: "Cagnotte envoyée avec succès", total: netAmount, gross: total, commission: commissionAmount, commission_rate: commissionRate, beneficiary_id, payout_method });
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
        if (!process.env.NOTCH_PUBLIC_KEY) {
            console.error('[NOTCH] NOTCH_PUBLIC_KEY non configuré dans les variables d\'environnement');
            return res.status(500).json({ error: "Configuration paiement manquante", details: "NOTCH_PUBLIC_KEY non défini sur le serveur" });
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
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
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
        const transferChannel = channel || 'cm.mobile';
        const formattedPhone = phone.startsWith('+') ? phone : `+237${phone.replace(/^0/, '')}`;
        const response = await axios.post('https://api.notchpay.co/transfers', {
            amount,
            currency: 'XAF',
            reference,
            recipient: formattedPhone,
            channel: transferChannel,
            description: `Retrait G-Caisse vers ${name}`
        }, { headers: { 'Authorization': process.env.NOTCH_PUBLIC_KEY, 'X-Grant': process.env.NOTCH_PRIVATE_KEY, 'Content-Type': 'application/json' } });

        const transferStatus = response.data?.transfer?.status || 'sent';
        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'withdrawal','completed',$3,'Retrait Mobile Money')",
            [user_id, amount, reference]
        );
        await db.query('COMMIT');
        res.json({ success: true, data: response.data, transfer_status: transferStatus });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('[PAYOUT ERROR]', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || "Erreur retrait" });
    }
});

// POST /api/transfer (transfert interne ou via Mobile Money)
app.post('/api/transfer', authenticate, requireFields('sender_id', 'receiver_phone', 'amount'), async (req, res) => {
    const { sender_id, receiver_phone, amount, operator } = req.body;
    try {
        await db.query('BEGIN');
        const sender = await db.query("SELECT balance, fullname FROM public.users WHERE id=$1", [sender_id]);
        if (sender.rows.length === 0 || sender.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ message: "Solde insuffisant" });
        }

        // Débit de l'expéditeur
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, sender_id]);

        if (operator && (operator === 'cm.orange' || operator === 'cm.mtn')) {
            // Transfert réel via Notch Pay (Orange Money / MTN MoMo)
            if (!process.env.NOTCH_PRIVATE_KEY) {
                await db.query('ROLLBACK');
                return res.status(500).json({ message: "Configuration paiement manquante" });
            }
            const reference = `XFER_${sender_id}_${Date.now()}`;
            try {
                const formattedPhone = receiver_phone.startsWith('+') ? receiver_phone : `+237${receiver_phone.replace(/^0/, '')}`;
                const notchRes = await axios.post('https://api.notchpay.co/transfers', {
                    amount,
                    currency: 'XAF',
                    reference,
                    recipient: formattedPhone,
                    channel: operator,
                    description: `Transfert G-Caisse vers ${receiver_phone}`
                }, { headers: { 'Authorization': process.env.NOTCH_PUBLIC_KEY, 'X-Grant': process.env.NOTCH_PRIVATE_KEY, 'Content-Type': 'application/json' } });

                await db.query("INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'transfer_out','completed',$3,$4)",
                    [sender_id, amount, reference, `Transfert ${operator === 'cm.orange' ? 'OM' : 'MoMo'} vers ${receiver_phone}`]);
                await db.query('COMMIT');
                return res.json({ message: `Transfert ${operator === 'cm.orange' ? 'Orange Money' : 'MTN MoMo'} effectué`, data: notchRes.data });
            } catch (notchErr) {
                // Rembourser l'expéditeur si Notch Pay échoue
                await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [amount, sender_id]);
                await db.query('ROLLBACK');
                return res.status(400).json({ message: notchErr.response?.data?.message || "Échec transfert Mobile Money" });
            }
        } else {
            // Transfert interne (balance à balance)
            const receiver = await db.query("SELECT id FROM public.users WHERE phone=$1", [receiver_phone]);
            if (receiver.rows.length === 0) {
                await db.query('ROLLBACK');
                return res.status(404).json({ message: "Destinataire non trouvé" });
            }
            const receiverId = receiver.rows[0].id;
            await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [amount, receiverId]);
            await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_out','completed','Transfert envoyé')", [sender_id, amount]);
            await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_in','completed','Transfert reçu')", [receiverId, amount]);
            await db.query('COMMIT');
            applyRoundUp(sender_id, amount);
            res.json({ message: "Transfert effectué" });
        }
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

// POST /api/services/airtime — Recharge depuis le solde G-Caisse via Notch Pay Transfers
app.post('/api/services/airtime', authenticate, requireFields('user_id', 'receiver_phone', 'amount', 'operator'), async (req, res) => {
    const { user_id, receiver_phone, amount, operator } = req.body;
    if (!process.env.NOTCH_PRIVATE_KEY) {
        return res.status(500).json({ message: "Configuration paiement manquante" });
    }
    try {
        // Vérifier le solde G-Caisse
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }

        const reference = `AIR_${user_id}_${Date.now()}`;
        const notchChannel = operator === 'cm.orange' ? 'cm.orange' : 'cm.mtn';
        const formattedPhone = receiver_phone.startsWith('+') ? receiver_phone : `+237${receiver_phone.replace(/^0/, '')}`;

        // Transférer l'argent au téléphone via Notch Pay (l'utilisateur reçoit du mobile money)
        await axios.post('https://api.notchpay.co/transfers', {
            amount,
            currency: 'XAF',
            reference,
            recipient: formattedPhone,
            channel: notchChannel,
            description: `Recharge G-Caisse vers ${receiver_phone}`
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'X-Grant': process.env.NOTCH_PRIVATE_KEY,
                'Content-Type': 'application/json'
            }
        });

        // Débiter le solde G-Caisse
        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'airtime','completed',$3,$4)",
            [user_id, amount, reference, `Recharge ${operator} - ${receiver_phone}`]
        );
        await db.query('COMMIT');

        res.json({ success: true, reference, message: "Recharge effectuée avec succès" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('[AIRTIME ERROR]', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || "Erreur recharge" });
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

// POST /api/services/:billType (eneo, camwater, SCHOOL, etc.) — Débité depuis le solde G-Caisse
app.post('/api/services/:billType', authenticate, requireFields('user_id', 'amount', 'phone'), async (req, res) => {
    const { user_id, amount, contract_number, phone, operator } = req.body;
    const { billType } = req.params;
    if (!process.env.NOTCH_PRIVATE_KEY) {
        return res.status(500).json({ message: "Configuration paiement manquante" });
    }
    try {
        // Vérifier le solde
        const userResult = await db.query("SELECT balance FROM public.users WHERE id=$1", [user_id]);
        if (userResult.rows.length === 0 || userResult.rows[0].balance < amount) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }

        const reference = `BILL_${billType.toUpperCase()}_${user_id}_${Date.now()}`;
        const notchChannel = operator === 'cm.orange' ? 'cm.orange' : 'cm.mtn';
        const formattedPhone = phone.startsWith('+') ? phone : `+237${phone.replace(/^0/, '')}`;

        // Transférer via Notch Pay (l'argent va au numéro de téléphone pour payer la facture)
        await axios.post('https://api.notchpay.co/transfers', {
            amount,
            currency: 'XAF',
            reference,
            recipient: formattedPhone,
            channel: notchChannel,
            description: `Paiement ${billType} - ${contract_number || ''}`
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'X-Grant': process.env.NOTCH_PRIVATE_KEY,
                'Content-Type': 'application/json'
            }
        });

        // Débiter le solde G-Caisse
        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amount, user_id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'bill','completed',$3,$4)",
            [user_id, amount, reference, `Facture ${billType} - ${contract_number || phone}`]
        );
        await db.query('COMMIT');

        res.json({ success: true, reference, message: `Facture ${billType} payée avec succès` });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('[BILL PAYMENT ERROR]', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || `Erreur paiement facture ${billType}` });
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
        // Commissions réellement collectées
        const fees = await db.query("SELECT COALESCE(SUM(commission_amount),0) as total_fees FROM public.platform_commissions");
        const volume = await db.query("SELECT COALESCE(SUM(amount),0) as total_volume FROM public.transactions WHERE status='completed'");
        const users = await db.query("SELECT COUNT(*) as user_count FROM public.users");
        const tontines = await db.query("SELECT COUNT(*) as tontine_count FROM public.tontines WHERE status='active'");
        const commissions = await db.query(`
            SELECT pc.*, t.name as tontine_name 
            FROM public.platform_commissions pc
            LEFT JOIN public.tontines t ON t.id = pc.tontine_id
            ORDER BY pc.created_at DESC LIMIT 20
        `);
        res.json({
            total_fees: fees.rows[0].total_fees,
            total_volume: volume.rows[0].total_volume,
            user_count: users.rows[0].user_count,
            tontine_count: tontines.rows[0].tontine_count,
            recent_commissions: commissions.rows
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// PARRAINAGE
// ==========================================

// GET /api/referral/code/:userId
app.get('/api/referral/code/:userId', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT referral_code, fullname FROM public.users WHERE id=$1", [req.params.userId]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        const referrals = await db.query("SELECT COUNT(*) as count FROM public.referrals WHERE referrer_id=$1", [req.params.userId]);
        res.json({
            referral_code: result.rows[0].referral_code,
            fullname: result.rows[0].fullname,
            total_referrals: parseInt(referrals.rows[0].count),
            bonus_per_referral: 500,
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/referral/history/:userId
app.get('/api/referral/history/:userId', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT r.*, u.fullname as referred_name, u.phone as referred_phone
            FROM public.referrals r
            JOIN public.users u ON u.id = r.referred_id
            WHERE r.referrer_id=$1
            ORDER BY r.created_at DESC
        `, [req.params.userId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// SCORE DE CONFIANCE & PREUVE VIDÉO
// ==========================================

// GET /api/users/:userId/trust-details
app.get('/api/users/:userId/trust-details', authenticate, async (req, res) => {
    try {
        const user = await db.query("SELECT credibility_score, created_at FROM public.users WHERE id=$1", [req.params.userId]);
        if (user.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });

        const payments = await db.query("SELECT COUNT(*) as count FROM public.tontine_payments WHERE user_id=$1 AND is_late=false", [req.params.userId]);
        const latePayments = await db.query("SELECT COUNT(*) as count FROM public.tontine_payments WHERE user_id=$1 AND is_late=true", [req.params.userId]);
        const referrals = await db.query("SELECT COUNT(*) as count FROM public.referrals WHERE referrer_id=$1", [req.params.userId]);
        const tontines = await db.query("SELECT COUNT(*) as count FROM public.tontine_members WHERE user_id=$1", [req.params.userId]);

        const onTime = parseInt(payments.rows[0].count);
        const late = parseInt(latePayments.rows[0].count);
        const total = onTime + late;
        const score = total > 0 ? Math.round((onTime / total) * 100) : user.rows[0].credibility_score;

        res.json({
            score: Math.min(100, Math.max(0, score)),
            on_time_payments: onTime,
            late_payments: late,
            referrals_count: parseInt(referrals.rows[0].count),
            tontines_count: parseInt(tontines.rows[0].count),
            member_since: user.rows[0].created_at,
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/tontines/:id/payout/:payoutId/proof
app.post('/api/tontines/:id/payout/:payoutId/proof', authenticate, requireFields('video_url'), async (req, res) => {
    try {
        await db.query("UPDATE public.tontine_payouts SET proof_video_url=$1 WHERE id=$2 AND tontine_id=$3",
            [req.body.video_url, req.params.payoutId, req.params.id]);
        res.json({ message: "Preuve vidéo enregistrée" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// TRANSFERT DIRECT OM/MoMo
// ==========================================

// POST /api/transfer/direct — Initie un transfert direct via Notch Pay
app.post('/api/transfer/direct', authenticate, requireFields('sender_id', 'sender_phone', 'sender_operator', 'receiver_phone', 'receiver_operator', 'amount'), async (req, res) => {
    const { sender_id, sender_phone, sender_operator, receiver_phone, receiver_operator, amount } = req.body;
    try {
        if (!process.env.NOTCH_PUBLIC_KEY) {
            return res.status(500).json({ message: "Configuration paiement manquante" });
        }
        const reference = `XFER_${sender_id}_${Date.now()}`;

        // Enregistrer le transfert en attente
        await db.query(`
            INSERT INTO public.pending_transfers 
              (sender_id, sender_phone, sender_operator, receiver_phone, receiver_operator, amount, payment_reference)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [sender_id, sender_phone, sender_operator, receiver_phone, receiver_operator, amount, reference]);

        // Initier le paiement Notch Pay (l'utilisateur paie depuis son OM/MoMo)
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount,
            currency: 'XAF',
            reference,
            callback: process.env.PAYMENT_CALLBACK_URL,
            customer: { name: `User ${sender_id}`, email: `user${sender_id}@g-caisse.com`, phone: sender_phone }
        }, {
            headers: {
                'Authorization': process.env.NOTCH_PUBLIC_KEY,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;
        const paymentUrl = data?.transaction?.payment_url || data?.authorization_url || data?.payment_url;
        if (!paymentUrl) {
            return res.status(400).json({ message: "URL de paiement non reçue", details: data });
        }

        res.json({ success: true, payment_url: paymentUrl, reference });
    } catch (err) {
        console.error('[TRANSFER DIRECT ERROR]', err.response?.data || err.message);
        res.status(400).json({ message: err.response?.data?.message || "Erreur initiation transfert" });
    }
});

// GET /api/transfer/direct/status/:ref — Vérifier le statut d'un transfert
app.get('/api/transfer/direct/status/:ref', authenticate, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM public.pending_transfers WHERE payment_reference=$1", [req.params.ref]);
        if (result.rows.length === 0) return res.status(404).json({ message: "Transfert non trouvé" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// DÉPÔT PAR VIREMENT BANCAIRE
// ==========================================

// Coordonnées bancaires de la plateforme (à configurer)
const BANK_INFO = {
    bank_name: process.env.BANK_NAME || 'UBA Cameroun',
    account_name: process.env.BANK_ACCOUNT_NAME || 'G-CAISSE SARL',
    account_number: process.env.BANK_ACCOUNT_NUMBER || '0000000000',
    iban: process.env.BANK_IBAN || '',
    swift: process.env.BANK_SWIFT || '',
};

// POST /api/bank-deposit — L'utilisateur déclare un virement
app.post('/api/bank-deposit', authenticate, requireFields('user_id', 'amount', 'bank_name'), async (req, res) => {
    const { user_id, amount, bank_name, sender_name } = req.body;
    try {
        const reference = `VIR_${user_id}_${Date.now()}`;
        await db.query(`
            INSERT INTO public.bank_deposits (user_id, amount, reference, bank_name, sender_name)
            VALUES ($1, $2, $3, $4, $5)
        `, [user_id, amount, reference, bank_name, sender_name || '']);
        res.status(201).json({
            message: "Déclaration enregistrée. Crédité après vérification.",
            reference,
            bank_info: BANK_INFO,
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/bank-deposit/info — Coordonnées bancaires de la plateforme
app.get('/api/bank-deposit/info', authenticate, (req, res) => {
    res.json(BANK_INFO);
});

// GET /api/bank-deposit/my — Liste des dépôts bancaires de l'utilisateur
app.get('/api/bank-deposit/my', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.bank_deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",
            [req.query.user_id || req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/admin/bank-deposits — Liste des dépôts en attente (admin)
app.get('/api/admin/bank-deposits', authenticate, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const result = await db.query(`
            SELECT bd.*, u.fullname as user_name, u.phone as user_phone
            FROM public.bank_deposits bd
            JOIN public.users u ON u.id = bd.user_id
            WHERE bd.status = $1
            ORDER BY bd.created_at DESC
        `, [status]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/admin/bank-deposits/:id/validate — Valider et créditer un virement (admin)
app.post('/api/admin/bank-deposits/:id/validate', authenticate, async (req, res) => {
    const { id } = req.params;
    const { admin_note } = req.body;
    try {
        const deposit = await db.query("SELECT * FROM public.bank_deposits WHERE id=$1 AND status='pending'", [id]);
        if (deposit.rows.length === 0) return res.status(404).json({ message: "Dépôt non trouvé ou déjà traité" });
        const d = deposit.rows[0];

        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [d.amount, d.user_id]);
        await db.query("UPDATE public.bank_deposits SET status='validated', admin_note=$1, validated_by=$2, validated_at=NOW() WHERE id=$3",
            [admin_note || '', req.user.id, id]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'deposit','completed',$3,$4)",
            [d.user_id, d.amount, d.reference, `Virement bancaire validé - ${d.bank_name}`]
        );
        await db.query('COMMIT');
        res.json({ message: "Virement validé et compte crédité" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/admin/bank-deposits/:id/reject — Rejeter un virement (admin)
app.post('/api/admin/bank-deposits/:id/reject', authenticate, async (req, res) => {
    const { id } = req.params;
    const { admin_note } = req.body;
    try {
        await db.query("UPDATE public.bank_deposits SET status='rejected', admin_note=$1, validated_by=$2, validated_at=NOW() WHERE id=$3 AND status='pending'",
            [admin_note || 'Non vérifié', req.user.id, id]);
        res.json({ message: "Virement rejeté" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ==========================================
// NOUVELLES FONCTIONNALITÉS
// ==========================================

// ── 1. DEMANDE D'ARGENT (REQUEST MONEY) ──────────────────────

// POST /api/money-request
app.post('/api/money-request', authenticate, requireFields('receiver_phone', 'amount'), async (req, res) => {
    const { receiver_phone, amount, message } = req.body;
    const sender_id = req.user.id;
    try {
        const receiver = await db.query("SELECT id, fullname FROM public.users WHERE phone=$1", [receiver_phone]);
        if (receiver.rows.length === 0) return res.status(404).json({ message: "Utilisateur non trouvé" });
        const receiver_id = receiver.rows[0].id;
        if (receiver_id === sender_id) return res.status(400).json({ message: "Tu ne peux pas te demander de l'argent à toi-même" });

        const sender = await db.query("SELECT fullname FROM public.users WHERE id=$1", [sender_id]);
        const result = await db.query(
            "INSERT INTO public.money_requests (sender_id, receiver_id, amount, message) VALUES ($1,$2,$3,$4) RETURNING *",
            [sender_id, receiver_id, amount, message || '']
        );

        await db.query(
            "INSERT INTO public.notifications (user_id, title, body, type, reference_id) VALUES ($1,$2,$3,'money_request',$4)",
            [receiver_id, 'Demande d\'argent', `${sender.rows[0].fullname} te demande ${amount} FCFA`, result.rows[0].id.toString()]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[MONEY REQUEST ERROR]', err.message);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/money-request/incoming
app.get('/api/money-request/incoming', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT mr.*, u.fullname as sender_name, u.phone as sender_phone
            FROM public.money_requests mr
            JOIN public.users u ON u.id = mr.sender_id
            WHERE mr.receiver_id=$1 AND mr.status='pending'
            ORDER BY mr.created_at DESC
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/money-request/outgoing
app.get('/api/money-request/outgoing', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT mr.*, u.fullname as receiver_name, u.phone as receiver_phone
            FROM public.money_requests mr
            JOIN public.users u ON u.id = mr.receiver_id
            WHERE mr.sender_id=$1
            ORDER BY mr.created_at DESC LIMIT 20
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/money-request/:id/accept
app.post('/api/money-request/:id/accept', authenticate, async (req, res) => {
    const { id } = req.params;
    try {
        const request = await db.query("SELECT * FROM public.money_requests WHERE id=$1 AND receiver_id=$2 AND status='pending'", [id, req.user.id]);
        if (request.rows.length === 0) return res.status(404).json({ message: "Demande non trouvée" });
        const r = request.rows[0];

        const senderBalance = await db.query("SELECT balance FROM public.users WHERE id=$1", [r.sender_id]);
        if (parseFloat(senderBalance.rows[0].balance) < parseFloat(r.amount)) {
            return res.status(400).json({ message: "Le demandeur n'a pas assez de solde" });
        }

        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [r.amount, r.sender_id]);
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [r.amount, r.receiver_id]);
        await db.query("UPDATE public.money_requests SET status='accepted', responded_at=NOW() WHERE id=$1", [id]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_out','completed','Demande d''argent acceptée')", [r.sender_id, r.amount]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'transfer_in','completed','Argent reçu (demande)')", [r.receiver_id, r.amount]);
        await db.query('COMMIT');

        res.json({ message: "Demande acceptée, argent transféré" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/money-request/:id/decline
app.post('/api/money-request/:id/decline', authenticate, async (req, res) => {
    try {
        await db.query("UPDATE public.money_requests SET status='declined', responded_at=NOW() WHERE id=$1 AND receiver_id=$2", [req.params.id, req.user.id]);
        res.json({ message: "Demande refusée" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ── 2. PARTAGE DE DÉPENSES (SPLIT BILL) ──────────────────────

// POST /api/split-bill
app.post('/api/split-bill', authenticate, requireFields('title', 'total_amount', 'participants'), async (req, res) => {
    const { title, total_amount, participants, split_type } = req.body;
    const creator_id = req.user.id;
    try {
        const result = await db.query(
            "INSERT INTO public.split_bills (creator_id, title, total_amount, split_type) VALUES ($1,$2,$3,$4) RETURNING *",
            [creator_id, title, total_amount, split_type || 'equal']
        );
        const billId = result.rows[0].id;
        const amountPerPerson = split_type === 'equal' ? Math.round(total_amount / (participants.length + 1) * 100) / 100 : 0;

        // Ajouter le créateur
        await db.query(
            "INSERT INTO public.split_bill_participants (split_bill_id, user_id, amount_owed) VALUES ($1,$2,$3)",
            [billId, creator_id, split_type === 'equal' ? amountPerPerson : (participants.find(p => p.user_id === creator_id)?.amount || 0)]
        );

        for (const p of participants) {
            let amountOwed = split_type === 'equal' ? amountPerPerson : (p.amount || 0);
            if (p.phone && !p.user_id) {
                const user = await db.query("SELECT id FROM public.users WHERE phone=$1", [p.phone]);
                if (user.rows.length > 0) {
                    await db.query(
                        "INSERT INTO public.split_bill_participants (split_bill_id, user_id, amount_owed) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                        [billId, user.rows[0].id, amountOwed]
                    );
                    await db.query(
                        "INSERT INTO public.notifications (user_id, title, body, type, reference_id) VALUES ($1,$2,$3,'split_bill',$4)",
                        [user.rows[0].id, 'Partage de dépenses', `Tu dois ${amountOwed} FCFA pour "${title}"`, billId.toString()]
                    );
                }
            } else if (p.user_id) {
                await db.query(
                    "INSERT INTO public.split_bill_participants (split_bill_id, user_id, amount_owed) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
                    [billId, p.user_id, amountOwed]
                );
            }
        }
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[SPLIT BILL ERROR]', err.message);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/split-bill/my
app.get('/api/split-bill/my', authenticate, async (req, res) => {
    try {
        const result = await db.query(`
            SELECT sb.*, u.fullname as creator_name,
                (SELECT json_agg(json_build_object('user_id', sp.user_id, 'name', u2.fullname, 'amount_owed', sp.amount_owed, 'amount_paid', sp.amount_paid, 'status', sp.status))
                 FROM public.split_bill_participants sp
                 JOIN public.users u2 ON u2.id = sp.user_id
                 WHERE sp.split_bill_id = sb.id) as participants
            FROM public.split_bills sb
            JOIN public.split_bill_participants p ON p.split_bill_id = sb.id
            JOIN public.users u ON u.id = sb.creator_id
            WHERE p.user_id = $1
            ORDER BY sb.created_at DESC LIMIT 20
        `, [req.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// POST /api/split-bill/:id/pay
app.post('/api/split-bill/:id/pay', authenticate, async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    try {
        const participant = await db.query(
            "SELECT sp.*, sb.creator_id FROM public.split_bill_participants sp JOIN public.split_bills sb ON sb.id = sp.split_bill_id WHERE sp.split_bill_id=$1 AND sp.user_id=$2 AND sp.status='pending'",
            [id, userId]
        );
        if (participant.rows.length === 0) return res.status(404).json({ message: "Participation non trouvée" });
        const p = participant.rows[0];
        const amountToPay = parseFloat(p.amount_owed) - parseFloat(p.amount_paid);

        const userBalance = await db.query("SELECT balance FROM public.users WHERE id=$1", [userId]);
        if (parseFloat(userBalance.rows[0].balance) < amountToPay) {
            return res.status(400).json({ message: "Solde insuffisant" });
        }

        await db.query('BEGIN');
        await db.query("UPDATE public.users SET balance = balance - $1 WHERE id=$2", [amountToPay, userId]);
        await db.query("UPDATE public.users SET balance = balance + $1 WHERE id=$2", [amountToPay, p.creator_id]);
        await db.query("UPDATE public.split_bill_participants SET amount_paid = amount_owed, status='paid', paid_at=NOW() WHERE split_bill_id=$1 AND user_id=$2", [id, userId]);
        await db.query("INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'split_bill_pay','completed','Partage de dépenses payé')", [userId, amountToPay]);
        await db.query('COMMIT');
        res.json({ message: "Paiement effectué" });
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ── 3. ÉPARGNE AUTOMATIQUE (ROUND-UP) ─────────────────────────

// PUT /api/users/:id/round-up-settings
app.put('/api/users/:id/round-up-settings', authenticate, async (req, res) => {
    const { enabled } = req.body;
    try {
        await db.query("UPDATE public.users SET round_up_enabled=$1 WHERE id=$2", [enabled, req.params.id]);
        res.json({ message: enabled ? "Épargne automatique activée" : "Épargne automatique désactivée" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/users/:id/round-up-stats
app.get('/api/users/:id/round-up-stats', authenticate, async (req, res) => {
    try {
        const user = await db.query("SELECT round_up_enabled, round_up_savings FROM public.users WHERE id=$1", [req.params.id]);
        const transactions = await db.query(
            "SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM public.transactions WHERE user_id=$1 AND type='round_up'",
            [req.params.id]
        );
        res.json({
            enabled: user.rows[0]?.round_up_enabled || false,
            total_saved: parseFloat(user.rows[0]?.round_up_savings || 0),
            transaction_count: parseInt(transactions.rows[0]?.count || 0)
        });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// Fonction utilitaire pour arrondir et épargner
async function applyRoundUp(userId, amount) {
    try {
        const user = await db.query("SELECT round_up_enabled FROM public.users WHERE id=$1", [userId]);
        if (!user.rows[0]?.round_up_enabled) return;

        const roundAmount = Math.ceil(amount / 100) * 100;
        const difference = roundAmount - amount;
        if (difference <= 0 || difference >= 100) return;

        await db.query("UPDATE public.users SET round_up_savings = round_up_savings + $1 WHERE id=$2", [difference, userId]);
        await db.query(
            "INSERT INTO public.transactions (user_id, amount, type, status, description) VALUES ($1,$2,'round_up','completed','Épargne automatique (arrondi)')",
            [userId, difference]
        );
    } catch (err) {
        console.error('[ROUND-UP ERROR]', err.message);
    }
}

// ── 4. CENTRE DE NOTIFICATIONS ────────────────────────────────

// GET /api/notifications
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
            [req.user.id]
        );
        const unread = await db.query("SELECT COUNT(*) as count FROM public.notifications WHERE user_id=$1 AND is_read=false", [req.user.id]);
        res.json({ notifications: result.rows, unread_count: parseInt(unread.rows[0].count) });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// PUT /api/notifications/:id/read
app.put('/api/notifications/:id/read', authenticate, async (req, res) => {
    try {
        await db.query("UPDATE public.notifications SET is_read=true WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
        res.json({ message: "Notification lue" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// PUT /api/notifications/read-all
app.put('/api/notifications/read-all', authenticate, async (req, res) => {
    try {
        await db.query("UPDATE public.notifications SET is_read=true WHERE user_id=$1", [req.user.id]);
        res.json({ message: "Toutes les notifications marquées comme lues" });
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// ── 5. PAIEMENTS PROGRAMMÉS ───────────────────────────────────

// POST /api/scheduled-payment
app.post('/api/scheduled-payment', authenticate, requireFields('payment_type', 'amount', 'next_payment_date'), async (req, res) => {
    const { payment_type, target_id, amount, frequency, next_payment_date, description } = req.body;
    try {
        const result = await db.query(`
            INSERT INTO public.scheduled_payments (user_id, payment_type, target_id, amount, frequency, next_payment_date, description)
            VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        `, [req.user.id, payment_type, target_id || null, amount, frequency || 'monthly', next_payment_date, description || '']);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// GET /api/scheduled-payment/my
app.get('/api/scheduled-payment/my', authenticate, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT * FROM public.scheduled_payments WHERE user_id=$1 AND is_active=true ORDER BY next_payment_date ASC",
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: "Erreur serveur" });
    }
});

// DELETE /api/scheduled-payment/:id
app.delete('/api/scheduled-payment/:id', authenticate, async (req, res) => {
    try {
        await db.query("UPDATE public.scheduled_payments SET is_active=false WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
        res.json({ message: "Paiement programmé annulé" });
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

    console.log('[WEBHOOK] Reçu:', rawBody.substring(0, 200));

    // Vérification de signature (si NOTCH_WEBHOOK_SECRET est configuré)
    if (process.env.NOTCH_WEBHOOK_SECRET) {
        if (!signature) {
            console.error('[WEBHOOK] Signature manquante');
            return res.status(401).send('Unauthorized');
        }
        const calculatedSig = crypto.createHmac('sha256', process.env.NOTCH_WEBHOOK_SECRET).update(rawBody).digest('hex');
        if (calculatedSig !== signature) {
            console.error('[WEBHOOK] Signature invalide. Calculée:', calculatedSig, 'Reçue:', signature);
            return res.status(400).send('Invalid signature');
        }
    } else {
        console.warn('[WEBHOOK] NOTCH_WEBHOOK_SECRET non configuré - signature non vérifiée');
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch (e) {
        console.error('[WEBHOOK] JSON invalide:', e.message);
        return res.status(400).send('Invalid JSON');
    }

    console.log('[WEBHOOK] Event:', event.type, event.data?.reference || '');

    if (event.type === 'payment.complete') {
        const { amount, reference } = event.data;

        // Dépôt classique (balance G-Caisse)
        if (reference.startsWith('DEP_')) {
            const userId = reference.split('_')[1];
            if (userId) {
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

        // Transfert direct OM↔MoMo
        if (reference.startsWith('XFER_')) {
            try {
                const pending = await db.query("SELECT * FROM public.pending_transfers WHERE payment_reference=$1 AND status='pending'", [reference]);
                if (pending.rows.length === 0) return res.status(200).send('Already processed');
                const pt = pending.rows[0];

                // Envoyer l'argent au destinataire via Notch Pay
                const notchChannel = pt.receiver_operator === 'cm.orange' ? 'cm.orange' : 'cm.mtn';
                const formattedReceiverPhone = pt.receiver_phone.startsWith('+') ? pt.receiver_phone : `+237${pt.receiver_phone.replace(/^0/, '')}`;
                await axios.post('https://api.notchpay.co/transfers', {
                    amount: pt.amount,
                    currency: 'XAF',
                    reference: `PAY_${reference}`,
                    recipient: formattedReceiverPhone,
                    channel: notchChannel,
                    description: `Transfert G-Caisse ${pt.sender_operator} → ${pt.receiver_operator}`
                }, {
                    headers: {
                        'Authorization': process.env.NOTCH_PUBLIC_KEY,
                        'X-Grant': process.env.NOTCH_PRIVATE_KEY,
                        'Content-Type': 'application/json'
                    }
                });

                // Marquer comme complété
                await db.query("UPDATE public.pending_transfers SET status='completed' WHERE id=$1", [pt.id]);
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'transfer_out','completed',$3,$4)",
                    [pt.sender_id, pt.amount, reference, `Transfert ${pt.sender_operator} → ${pt.receiver_operator} vers ${pt.receiver_phone}`]
                );
                return res.status(200).send('OK');
            } catch (err) {
                console.error('[WEBHOOK XFER ERROR]', err.response?.data || err.message);
                await db.query("UPDATE public.pending_transfers SET status='failed' WHERE payment_reference=$1", [reference]).catch(() => {});
                return res.status(500).send('Transfer Error');
            }
        }

        // Paiement de facture (ENEO, CamWater, etc.)
        if (reference.startsWith('BILL_')) {
            try {
                const pending = await db.query("SELECT * FROM public.pending_transfers WHERE payment_reference=$1 AND status='pending'", [reference]);
                if (pending.rows.length === 0) return res.status(200).send('Already processed');
                const pt = pending.rows[0];
                const billName = pt.receiver_phone.replace('BILL_', '');

                // Marquer comme payé
                await db.query("UPDATE public.pending_transfers SET status='completed' WHERE id=$1", [pt.id]);
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'bill','completed',$3,$4)",
                    [pt.sender_id, pt.amount, reference, `Facture ${billName} payée`]
                );
                return res.status(200).send('OK');
            } catch (err) {
                console.error('[WEBHOOK BILL ERROR]', err.message);
                await db.query("UPDATE public.pending_transfers SET status='failed' WHERE payment_reference=$1", [reference]).catch(() => {});
                return res.status(500).send('Bill Error');
            }
        }

        // Recharge airtime/data
        if (reference.startsWith('AIR_')) {
            try {
                const pending = await db.query("SELECT * FROM public.pending_transfers WHERE payment_reference=$1 AND status='pending'", [reference]);
                if (pending.rows.length === 0) return res.status(200).send('Already processed');
                const pt = pending.rows[0];

                // Marquer comme payé
                await db.query("UPDATE public.pending_transfers SET status='completed' WHERE id=$1", [pt.id]);
                await db.query(
                    "INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1,$2,'airtime','completed',$3,$4)",
                    [pt.sender_id, pt.amount, reference, `Recharge ${pt.receiver_operator} - ${pt.receiver_phone}`]
                );
                return res.status(200).send('OK');
            } catch (err) {
                console.error('[WEBHOOK AIRTIME ERROR]', err.message);
                await db.query("UPDATE public.pending_transfers SET status='failed' WHERE payment_reference=$1", [reference]).catch(() => {});
                return res.status(500).send('Airtime Error');
            }
        }
    }
    res.status(200).send('Event ignored');
});

app.listen(port, () => console.log(`🚀 Serveur G-Caisse démarré sur le port ${port}`));
