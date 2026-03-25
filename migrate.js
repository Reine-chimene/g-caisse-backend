/**
 * migrate.js — Script de migration G-Caisse
 *
 * Usage :
 *   node migrate.js          → exécute toutes les migrations
 *   node migrate.js --dry    → affiche ce qui serait fait sans rien modifier
 *
 * Ce script est idempotent : on peut le relancer autant de fois qu'on veut,
 * il ne touche jamais aux données existantes.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: false }
});

const isDry = process.argv.includes('--dry');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/** Vérifie si une table existe dans le schéma public */
async function tableExists(client, tableName) {
    const res = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [tableName]
    );
    return res.rows.length > 0;
}

/** Vérifie si une colonne existe dans une table */
async function columnExists(client, tableName, columnName) {
    const res = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = $1
           AND column_name  = $2`,
        [tableName, columnName]
    );
    return res.rows.length > 0;
}

/** Vérifie si un index existe */
async function indexExists(client, indexName) {
    const res = await client.query(
        `SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = $1`,
        [indexName]
    );
    return res.rows.length > 0;
}

/** Exécute ou simule une requête SQL */
async function run(client, label, sql) {
    if (isDry) {
        console.log(`  [DRY] ${label}`);
        return;
    }
    await client.query(sql);
    console.log(`  ✅ ${label}`);
}

/** Crée une table si elle n'existe pas */
async function createTableIfMissing(client, tableName, ddl) {
    const exists = await tableExists(client, tableName);
    if (!exists) {
        await run(client, `Création table "${tableName}"`, ddl);
    } else {
        console.log(`  ⏭  Table "${tableName}" déjà présente`);
    }
}

/** Ajoute une colonne si elle n'existe pas */
async function addColumnIfMissing(client, tableName, columnName, columnDef) {
    const exists = await columnExists(client, tableName, columnName);
    if (!exists) {
        await run(
            client,
            `Ajout colonne "${tableName}.${columnName}"`,
            `ALTER TABLE public.${tableName} ADD COLUMN ${columnName} ${columnDef}`
        );
    } else {
        console.log(`  ⏭  Colonne "${tableName}.${columnName}" déjà présente`);
    }
}

/** Crée un index si il n'existe pas */
async function createIndexIfMissing(client, indexName, ddl) {
    const exists = await indexExists(client, indexName);
    if (!exists) {
        await run(client, `Création index "${indexName}"`, ddl);
    } else {
        console.log(`  ⏭  Index "${indexName}" déjà présent`);
    }
}

// ─────────────────────────────────────────────
// DÉFINITION DES MIGRATIONS
// ─────────────────────────────────────────────

const migrations = [

    // ── 1. TABLES DE BASE ──────────────────────────────────────────────────

    {
        name: 'table users',
        run: (c) => createTableIfMissing(c, 'users', `
            CREATE TABLE public.users (
                id               SERIAL PRIMARY KEY,
                fullname         TEXT,
                phone            TEXT UNIQUE,
                pincode_hash     TEXT,
                balance          DECIMAL DEFAULT 0,
                credibility_score INTEGER DEFAULT 100,
                latitude         DOUBLE PRECISION,
                longitude        DOUBLE PRECISION,
                fcm_token        TEXT,
                created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table tontines',
        run: (c) => createTableIfMissing(c, 'tontines', `
            CREATE TABLE public.tontines (
                id                      SERIAL PRIMARY KEY,
                name                    TEXT,
                admin_id                INTEGER REFERENCES public.users(id),
                frequency               TEXT,
                amount_to_pay           DECIMAL,
                commission_rate         DECIMAL,
                current_beneficiary_id  INTEGER REFERENCES public.users(id),
                created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table tontine_members',
        run: (c) => createTableIfMissing(c, 'tontine_members', `
            CREATE TABLE public.tontine_members (
                id           SERIAL PRIMARY KEY,
                tontine_id   INTEGER REFERENCES public.tontines(id),
                user_id      INTEGER REFERENCES public.users(id),
                payout_method TEXT DEFAULT 'G-Caisse',
                joined_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table social_funds',
        run: (c) => createTableIfMissing(c, 'social_funds', `
            CREATE TABLE public.social_funds (
                id          SERIAL PRIMARY KEY,
                tontine_id  INTEGER UNIQUE REFERENCES public.tontines(id),
                balance     DECIMAL DEFAULT 0,
                last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table transactions',
        run: (c) => createTableIfMissing(c, 'transactions', `
            CREATE TABLE public.transactions (
                id          SERIAL PRIMARY KEY,
                user_id     INTEGER REFERENCES public.users(id),
                amount      DECIMAL,
                type        TEXT,
                status      TEXT,
                reference   TEXT,
                description TEXT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table tontine_messages',
        run: (c) => createTableIfMissing(c, 'tontine_messages', `
            CREATE TABLE public.tontine_messages (
                id          SERIAL PRIMARY KEY,
                tontine_id  INTEGER REFERENCES public.tontines(id),
                user_id     INTEGER REFERENCES public.users(id),
                content     TEXT,
                message_type TEXT DEFAULT 'text',
                voice_url   TEXT,
                duration_sec INTEGER,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table auctions',
        run: (c) => createTableIfMissing(c, 'auctions', `
            CREATE TABLE public.auctions (
                id          SERIAL PRIMARY KEY,
                tontine_id  INTEGER REFERENCES public.tontines(id),
                user_id     INTEGER REFERENCES public.users(id),
                bid_amount  DECIMAL,
                status      TEXT DEFAULT 'open',
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table savings_goals',
        run: (c) => createTableIfMissing(c, 'savings_goals', `
            CREATE TABLE public.savings_goals (
                id             SERIAL PRIMARY KEY,
                user_id        INTEGER REFERENCES public.users(id),
                name           TEXT,
                target_amount  DECIMAL,
                current_amount DECIMAL DEFAULT 0,
                created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table loans',
        run: (c) => createTableIfMissing(c, 'loans', `
            CREATE TABLE public.loans (
                id         SERIAL PRIMARY KEY,
                user_id    INTEGER REFERENCES public.users(id),
                amount     DECIMAL,
                purpose    TEXT,
                type       TEXT,
                status     TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table social_events',
        run: (c) => createTableIfMissing(c, 'social_events', `
            CREATE TABLE public.social_events (
                id            SERIAL PRIMARY KEY,
                title         TEXT,
                description   TEXT,
                event_type    TEXT DEFAULT 'other',
                target_amount DECIMAL DEFAULT 0,
                collected     DECIMAL DEFAULT 0,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },
    {
        name: 'table airtime_pending',
        run: (c) => createTableIfMissing(c, 'airtime_pending', `
            CREATE TABLE public.airtime_pending (
                id                SERIAL PRIMARY KEY,
                payment_reference TEXT UNIQUE,
                receiver_phone    TEXT,
                operator          TEXT,
                service_type      TEXT DEFAULT 'Credit',
                plan_validity     TEXT,
                amount            DECIMAL,
                created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`)
    },

    // ── 2. COLONNES MANQUANTES SUR TABLES EXISTANTES ───────────────────────

    {
        name: 'colonne users.fcm_token',
        run: (c) => addColumnIfMissing(c, 'users', 'fcm_token', 'TEXT')
    },
    {
        name: 'colonne users.latitude',
        run: (c) => addColumnIfMissing(c, 'users', 'latitude', 'DOUBLE PRECISION')
    },
    {
        name: 'colonne users.longitude',
        run: (c) => addColumnIfMissing(c, 'users', 'longitude', 'DOUBLE PRECISION')
    },
    {
        name: 'colonne users.credibility_score',
        run: (c) => addColumnIfMissing(c, 'users', 'credibility_score', 'INTEGER DEFAULT 100')
    },
    {
        name: 'colonne transactions.reference',
        run: (c) => addColumnIfMissing(c, 'transactions', 'reference', 'TEXT')
    },
    {
        name: 'colonne transactions.description',
        run: (c) => addColumnIfMissing(c, 'transactions', 'description', 'TEXT')
    },
    {
        name: 'colonne tontines.commission_rate',
        run: (c) => addColumnIfMissing(c, 'tontines', 'commission_rate', 'DECIMAL')
    },
    {
        name: 'colonne tontines.current_beneficiary_id',
        run: (c) => addColumnIfMissing(c, 'tontines', 'current_beneficiary_id', 'INTEGER REFERENCES public.users(id)')
    },
    {
        name: 'colonne tontine_members.payout_method',
        run: (c) => addColumnIfMissing(c, 'tontine_members', 'payout_method', "TEXT DEFAULT 'G-Caisse'")
    },
    {
        name: 'colonne tontine_messages.message_type',
        run: (c) => addColumnIfMissing(c, 'tontine_messages', 'message_type', "TEXT DEFAULT 'text'")
    },
    {
        name: 'colonne tontine_messages.voice_url',
        run: (c) => addColumnIfMissing(c, 'tontine_messages', 'voice_url', 'TEXT')
    },
    {
        name: 'colonne tontine_messages.duration_sec',
        run: (c) => addColumnIfMissing(c, 'tontine_messages', 'duration_sec', 'INTEGER')
    },
    {
        name: 'colonne social_events.event_type',
        run: (c) => addColumnIfMissing(c, 'social_events', 'event_type', "TEXT DEFAULT 'other'")
    },
    {
        name: 'colonne social_events.collected',
        run: (c) => addColumnIfMissing(c, 'social_events', 'collected', 'DECIMAL DEFAULT 0')
    },

    // ── 3. INDEX DE PERFORMANCE ────────────────────────────────────────────

    {
        name: 'index transactions.user_id',
        run: (c) => createIndexIfMissing(
            c,
            'idx_transactions_user_id',
            'CREATE INDEX idx_transactions_user_id ON public.transactions(user_id)'
        )
    },
    {
        name: 'index transactions.reference',
        run: (c) => createIndexIfMissing(
            c,
            'idx_transactions_reference',
            'CREATE INDEX idx_transactions_reference ON public.transactions(reference)'
        )
    },
    {
        name: 'index tontine_members.tontine_id',
        run: (c) => createIndexIfMissing(
            c,
            'idx_tontine_members_tontine_id',
            'CREATE INDEX idx_tontine_members_tontine_id ON public.tontine_members(tontine_id)'
        )
    },
    {
        name: 'index tontine_messages.tontine_id',
        run: (c) => createIndexIfMissing(
            c,
            'idx_tontine_messages_tontine_id',
            'CREATE INDEX idx_tontine_messages_tontine_id ON public.tontine_messages(tontine_id)'
        )
    },
];

// ─────────────────────────────────────────────
// EXÉCUTION
// ─────────────────────────────────────────────

async function migrate() {
    const client = await pool.connect();
    let passed = 0;
    let failed = 0;

    console.log('\n🔧 G-CAISSE — Migration de la base de données');
    console.log(`   Mode : ${isDry ? 'DRY RUN (aucune modification)' : 'LIVE'}`);
    console.log(`   DB   : ${process.env.DB_NAME}@${process.env.DB_HOST}\n`);

    try {
        for (const migration of migrations) {
            console.log(`▶ ${migration.name}`);
            try {
                await migration.run(client);
                passed++;
            } catch (err) {
                console.error(`  ❌ Erreur sur "${migration.name}" : ${err.message}`);
                failed++;
            }
        }
    } finally {
        client.release();
        await pool.end();
    }

    console.log(`\n─────────────────────────────────────`);
    console.log(`✅ Réussies : ${passed} | ❌ Échouées : ${failed}`);
    console.log(`─────────────────────────────────────\n`);

    if (failed > 0) process.exit(1);
}

migrate();
