-- ================================================================
-- HR BMW U11 Chatbot — Script SQL pour Neon PostgreSQL
-- Coller ce script dans : console.neon.tech → SQL Editor
-- ================================================================
-- ⚠️ RÈGLES MÉTIER CRITIQUES (lire avant modification) :
--   ML  = Maladie SEULEMENT          (colonne ml)
--   MD  = Mise en demeure SEULEMENT   (colonne md)
--   maladie         = ml SEULEMENT    (JAMAIS ml + md)
--   mise_en_demeure = md SEULEMENT    (JAMAIS ml + md)
--   Total Abs = P + NP
--   Taux Abs NP = NP / actif * 100
--   Taux Abs P  = P  / actif * 100
--   Delta = IST - Soll
-- ================================================================

-- ────────────────────────────────────────────────────────────────
-- TABLE 1 : daily_hr_report
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_hr_report (
    id              SERIAL PRIMARY KEY,
    report_date     DATE NOT NULL,
    plant           TEXT DEFAULT 'BMW U11',
    perimeter       TEXT,
    process         TEXT,
    circuit         TEXT,
    group_name      TEXT,
    area            TEXT,

    -- Effectifs
    actif           NUMERIC DEFAULT 0,
    present         NUMERIC DEFAULT 0,
    nb_abs          NUMERIC DEFAULT 0,

    -- Absences planifiées / non planifiées
    p               NUMERIC DEFAULT 0,   -- Absence planifiée
    np              NUMERIC DEFAULT 0,   -- Absence non planifiée

    -- Indicateurs spéciaux (INDÉPENDANTS — ne jamais fusionner avec ml/md)
    sq              NUMERIC DEFAULT 0,   -- Sans questionnaire
    ac              NUMERIC DEFAULT 0,   -- Absence continue
    rv              NUMERIC DEFAULT 0,   -- Rendez-vous

    -- ⚠️ CRITIQUE : ml et md sont DEUX indicateurs SÉPARÉS
    ml              NUMERIC DEFAULT 0,   -- Maladie (ML uniquement)
    md              NUMERIC DEFAULT 0,   -- Mise en demeure (MD uniquement)

    -- Colonnes dérivées (calculées à l'import)
    -- maladie         = ml SEULEMENT  (JAMAIS ml + md)
    maladie         NUMERIC DEFAULT 0,
    -- mise_en_demeure = md SEULEMENT  (JAMAIS ml + md)
    mise_en_demeure NUMERIC DEFAULT 0,

    -- Taux
    abs_p_rate      NUMERIC DEFAULT 0,   -- P / actif * 100
    abs_np_rate     NUMERIC DEFAULT 0,   -- NP / actif * 100
    total_abs       NUMERIC DEFAULT 0,   -- P + NP
    taux_presence   NUMERIC DEFAULT 0,   -- present / actif * 100

    -- Heures
    heures_presence NUMERIC DEFAULT 0,
    retard          NUMERIC DEFAULT 0,
    heures_sup      NUMERIC DEFAULT 0,

    -- Production
    soll            NUMERIC DEFAULT 0,
    ist             NUMERIC DEFAULT 0,
    delta           NUMERIC DEFAULT 0,   -- IST - Soll

    -- Audit
    raw_json        JSONB,
    source_file     TEXT,
    uploaded_by     TEXT,
    uploaded_at     TIMESTAMP DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- TABLE 2 : import_history
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_history (
    id                  SERIAL PRIMARY KEY,
    report_date         DATE,
    plant               TEXT,
    source_file         TEXT,
    uploaded_by         TEXT,
    rows_imported       INTEGER DEFAULT 0,
    status              TEXT DEFAULT 'success',  -- success | error
    error_message       TEXT,
    detected_columns    TEXT[],
    missing_columns     TEXT[],
    parse_source        TEXT,                    -- html_table | js_var:xxx | csv | excel
    uploaded_at         TIMESTAMP DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- TABLE 3 : allowed_whatsapp_users
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS allowed_whatsapp_users (
    id                  SERIAL PRIMARY KEY,
    phone_number        TEXT UNIQUE NOT NULL,
    full_name           TEXT,
    role                TEXT NOT NULL,           -- hr_admin | supervisor | employee
    allowed_scope_type  TEXT,                    -- plant | perimeter | process | circuit | group_name | all
    allowed_scope_value TEXT,                    -- ex: 'Assembly', 'PGTF', 'G-855', 'BMW U11'
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- TABLE 4 : question_logs
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS question_logs (
    id                    SERIAL PRIMARY KEY,
    phone_number          TEXT,
    user_message          TEXT,
    detected_language     TEXT,                  -- fr | ar | tn_latin
    detected_intent       TEXT,                  -- get_metric | get_summary | compare | top | unknown
    detected_metric       TEXT,
    detected_scope_type   TEXT,
    detected_scope_value  TEXT,
    detected_date         DATE,
    bot_response          TEXT,
    sql_executed          TEXT,
    execution_ms          INTEGER,
    created_at            TIMESTAMP DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- INDEX DE PERFORMANCE
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_hr_report_date       ON daily_hr_report(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_plant_date        ON daily_hr_report(plant, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_process_date      ON daily_hr_report(process, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_circuit_date      ON daily_hr_report(circuit, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_group_date        ON daily_hr_report(group_name, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_hr_perimeter_date    ON daily_hr_report(perimeter, report_date DESC);
CREATE INDEX IF NOT EXISTS idx_import_date          ON import_history(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_wa_users_phone       ON allowed_whatsapp_users(phone_number);
CREATE INDEX IF NOT EXISTS idx_question_logs_phone  ON question_logs(phone_number, created_at DESC);

-- ────────────────────────────────────────────────────────────────
-- VUE : résumé par plant et date
-- ⚠️ SUM(ml) AS maladie  — jamais SUM(ml) + SUM(md)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_daily_plant_summary AS
SELECT
    report_date,
    plant,
    SUM(actif)          AS actif,
    SUM(present)        AS present,
    SUM(nb_abs)         AS nb_abs,
    SUM(p)              AS p,
    SUM(np)             AS np,
    SUM(sq)             AS sq,
    SUM(ac)             AS ac,
    SUM(rv)             AS rv,
    SUM(ml)             AS maladie,           -- ML = maladie SEULEMENT
    SUM(md)             AS mise_en_demeure,   -- MD = mise en demeure SEULEMENT
    SUM(total_abs)      AS total_abs,
    ROUND(SUM(np) / NULLIF(SUM(actif), 0) * 100, 2) AS abs_np_rate,
    ROUND(SUM(p)  / NULLIF(SUM(actif), 0) * 100, 2) AS abs_p_rate,
    ROUND(SUM(present) / NULLIF(SUM(actif), 0) * 100, 2) AS taux_presence,
    SUM(retard)         AS retard,
    SUM(heures_sup)     AS heures_sup,
    SUM(soll)           AS soll,
    SUM(ist)            AS ist,
    SUM(delta)          AS delta
FROM daily_hr_report
GROUP BY report_date, plant;

-- VUE : dernière date disponible
CREATE OR REPLACE VIEW v_latest_date AS
SELECT MAX(report_date) AS latest_date FROM daily_hr_report;

-- ────────────────────────────────────────────────────────────────
-- DONNÉES DE DÉMONSTRATION — Utilisateurs WhatsApp autorisés
-- ────────────────────────────────────────────────────────────────
INSERT INTO allowed_whatsapp_users
    (phone_number, full_name, role, allowed_scope_type, allowed_scope_value)
VALUES
    ('+21650505484', 'HR Admin BMW U11',  'hr_admin',   'plant',      'BMW U11'),
    ('+21698000002', 'Superviseur Assembly', 'supervisor', 'process',  'Assembly'),
    ('+21698000003', 'Superviseur PGTF',   'supervisor', 'perimeter', 'PGTF'),
    ('+21698000004', 'Superviseur G-855',  'supervisor', 'group_name','G-855')
ON CONFLICT (phone_number) DO NOTHING;

-- ────────────────────────────────────────────────────────────────
-- VÉRIFICATION FINALE
-- ────────────────────────────────────────────────────────────────
SELECT 'Tables créées :' AS status;
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('daily_hr_report','import_history','allowed_whatsapp_users','question_logs')
ORDER BY table_name;

SELECT 'Utilisateurs démo :' AS status;
SELECT phone_number, full_name, role, allowed_scope_type, allowed_scope_value
FROM allowed_whatsapp_users;
