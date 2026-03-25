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

// ==========================================
// CONFIGURATIONS (Cloudinary & Multer)
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
        const allowed = ['audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'application/octet-stream'];
        cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(aac|mp3|m4a|ogg|wav|webm)$/i) !== null);
    }
});

// ==========================================
// MIDDLEWARES
// ==========================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
    if (req.path === '/api/webhook') return next();
    bodyParser.json()(req, res, next);
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const authenticate = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Token manquant' });

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
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
        console.log("🔍 Initialisation DB...");
        await db.query(`CREATE TABLE IF NOT EXISTS public.users (id SERIAL PRIMARY KEY, fullname TEXT, phone TEXT UNIQUE, pincode_hash TEXT, balance DECIMAL DEFAULT 0, credibility_score INTEGER DEFAULT 100, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, fcm_token TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await db.query(`CREATE TABLE IF NOT EXISTS public.transactions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES public.users(id), amount DECIMAL, type TEXT, status TEXT, reference TEXT, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log("✅ Base de données prête.");
    } catch (err) {
        console.error("❌ Erreur DB:", err);
    }
};
initDb();

// ==========================================
// ROUTES AUTHENTIFICATION
// ==========================================

// INSCRIPTION (Nécessaire pour hacher le code PIN correctement)
app.post('/api/register', requireFields('fullname', 'phone', 'pincode'), async (req, res) => {
    const { fullname, phone, pincode } = req.body;
    try {
        const pincode_hash = await bcrypt.hash(String(pincode), SALT_ROUNDS);
        const result = await db.query(
            "INSERT INTO public.users (fullname, phone, pincode_hash) VALUES ($1, $2, $3) RETURNING id, fullname, phone",
            [fullname, phone, pincode_hash]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ message: "Ce numéro existe déjà" });
        res.status(500).json({ message: "Erreur lors de l'inscription" });
    }
});

// LOGIN (Corrigé avec logs de débogage)
// Route de connexion (Version sans hachage pour test)
app.post('/api/login', async (req, res) => {
    const { phone, pincode } = req.body;

    try {
        // Recherche de l'utilisateur par téléphone
        const result = await db.query(
            "SELECT * FROM public.users WHERE phone = $1", 
            [phone]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Utilisateur non trouvé" });
        }

        const user = result.rows[0];

        // COMPARAISON DIRECTE (Texte brut)
        // On compare ce que l'utilisateur a tapé avec la colonne pincode_hash
        if (String(pincode) !== String(user.pincode_hash)) {
            return res.status(401).json({ message: "Code PIN incorrect" });
        }

        // Création du token JWT pour les prochaines requêtes
        const token = jwt.sign(
            { id: user.id, phone: user.phone }, 
            process.env.JWT_SECRET || 'votre_cle_secrete', 
            { expiresIn: '7d' }
        );

        // On retire le code PIN de l'objet avant de l'envoyer au téléphone
        delete user.pincode_hash;

        res.json({
            ...user,
            token: token
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erreur serveur lors de la connexion" });
    }
});
// ==========================================
// AUTRES ROUTES (Dépôt & Webhook)
// ==========================================

app.get('/', (req, res) => {
    res.send('<h1 style="color: #FF7900; text-align: center;">🚀 SERVEUR G-CAISSE LIVE OPERATIONAL</h1>');
});

app.post('/api/deposit', authenticate, requireFields('amount', 'user_id', 'name'), async (req, res) => {
    const { amount, user_id, name, email, phone } = req.body;
    const reference = `DEP_${user_id}_${Date.now()}`;
    try {
        const response = await axios.post('https://api.notchpay.co/payments', {
            amount, currency: 'XAF', reference,
            callback: process.env.PAYMENT_CALLBACK_URL,
            customer: { name, email: email || `user${user_id}@g-caisse.com`, phone }
        }, {
            headers: { 'Authorization': process.env.NOTCH_PUBLIC_KEY, 'Content-Type': 'application/json' }
        });
        res.json({ success: true, payment_url: response.data.authorization_url });
    } catch (err) {
        res.status(400).json({ error: "Erreur Notch Pay" });
    }
});

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
                const userUpdate = await db.query("UPDATE public.users SET balance = balance + $1 WHERE id = $2 RETURNING id", [amount, userId]);
                if (userUpdate.rows.length > 0) {
                    await db.query("INSERT INTO public.transactions (user_id, amount, type, status, reference, description) VALUES ($1, $2, 'deposit', 'completed', $3, 'Dépôt Notch Pay')", [userId, amount, reference]);
                }
                await db.query('COMMIT');
                return res.status(200).send('OK');
            } catch (err) {
                await db.query('ROLLBACK');
                return res.status(500).send('DB Error');
            }
        }
    }
    res.status(200).send('Event ignored');
});

app.listen(port, () => console.log(`🚀 Serveur démarré sur le port ${port}`));