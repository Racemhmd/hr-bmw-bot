-- ============================================================
-- HR BMW U11 Chatbot — Script d'initialisation PostgreSQL v2
-- CORRECTION CRITIQUE : ML = Maladie | MD = Mise en demeure
-- ============================================================

CREATE SCHEMA IF NOT EXISTS public;

-- ------------------------------------------------------------
-- TABLE : daily_hr_report  (v2 — schéma complet)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS daily_hr_report CASCADE;

CREATE TABLE IF NOT EXISTS daily_hr_report (
    id                  SERIAL PRIMARY KEY,
    report_date         DATE NOT NULL,
    plant               TEXT DEFAULT 'BMW U11',
    perimeter           TEXT,
    process             TEXT,
    circuit             TEXT,
    group_name          TEXT,
    area                TEXT,

    -- Effectifs
    actif               NUMERIC DEFAULT 0,
    present             NUMERIC DEFAULT 0,
    nb_abs              NUMERIC DEFAULT 0,

    -- Absences détaillées
    p                   NUMERIC DEFAULT 0,    -- Absence Planifiée
    np                  NUMERIC DEFAULT 0,    -- Absence Non Planifiée
    sq                  NUMERIC DEFAULT 0,    -- Sans Questionnaire
    ac                  NUMERIC DEFAULT 0,    -- Absence Continue
    rv                  NUMERIC DEFAULT 0,    -- Rendez-vous

    -- Maladies & Disciplinaire (SÉPARÉS — NE JAMAIS FUSIONNER)
    ml                  NUMERIC DEFAULT 0,    -- Maladie (ML)
    md                  NUMERIC DEFAULT 0,    -- Mise en demeure (MD)
    maladie             NUMERIC DEFAULT 0,    -- = ML seulement (JAMAIS ML+MD)
    mise_en_demeure     NUMERIC DEFAULT 0,    -- = MD seulement

    -- Taux calculés
    abs_p_rate          NUMERIC DEFAULT 0,    -- P / actif * 100
    abs_np_rate         NUMERIC DEFAULT 0,    -- NP / actif * 100
    total_abs           NUMERIC DEFAULT 0,    -- P + NP
    taux_presence       NUMERIC DEFAULT 0,    -- present / actif * 100

    -- Heures
    heures_presence     NUMERIC DEFAULT 0,
    retard              NUMERIC DEFAULT 0,
    heures_sup          NUMERIC DEFAULT 0,

    -- Soll/IST/Delta
    soll                NUMERIC DEFAULT 0,
    ist                 NUMERIC DEFAULT 0,
    delta               NUMERIC DEFAULT 0,    -- IST - Soll

    -- Metadata
    raw_json            JSONB,                -- Ligne brute originale
    source_file         TEXT,
    uploaded_by         TEXT,
    uploaded_at         TIMESTAMP DEFAULT NOW()
);

-- Contrainte CHECK pour éviter maladie = ml + md accidentellement
-- (documentation seulement, pas une contrainte stricte SQL)
COMMENT ON COLUMN daily_hr_report.maladie IS 'ATTENTION: = ML seulement. Ne jamais calculer comme ML + MD.';
COMMENT ON COLUMN daily_hr_report.mise_en_demeure IS 'ATTENTION: = MD seulement. Indicateur séparé de maladie.';
COMMENT ON COLUMN daily_hr_report.ml IS 'Maladie légale (ML)';
COMMENT ON COLUMN daily_hr_report.md IS 'Mise en demeure (MD)';
COMMENT ON COLUMN daily_hr_report.sq IS 'Sans questionnaire (SQ)';
COMMENT ON COLUMN daily_hr_report.ac IS 'Absence continue (AC)';
COMMENT ON COLUMN daily_hr_report.rv IS 'Rendez-vous (RV)';

-- Index principaux
CREATE INDEX IF NOT EXISTS idx_daily_hr_date         ON daily_hr_report(report_date);
CREATE INDEX IF NOT EXISTS idx_daily_hr_plant        ON daily_hr_report(plant);
CREATE INDEX IF NOT EXISTS idx_daily_hr_group        ON daily_hr_report(group_name);
CREATE INDEX IF NOT EXISTS idx_daily_hr_process      ON daily_hr_report(process);
CREATE INDEX IF NOT EXISTS idx_daily_hr_circuit      ON daily_hr_report(circuit);
CREATE INDEX IF NOT EXISTS idx_daily_hr_perimeter    ON daily_hr_report(perimeter);
CREATE INDEX IF NOT EXISTS idx_daily_hr_area         ON daily_hr_report(area);
CREATE INDEX IF NOT EXISTS idx_daily_hr_date_plant   ON daily_hr_report(report_date, plant);

-- ------------------------------------------------------------
-- TABLE : import_history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_history (
    id                  SERIAL PRIMARY KEY,
    report_date         DATE,
    plant               TEXT,
    source_file         TEXT,
    file_type           TEXT,
    uploaded_by         TEXT,
    rows_imported       INTEGER DEFAULT 0,
    rows_deleted        INTEGER DEFAULT 0,
    status              TEXT,                 -- success | error
    error_message       TEXT,
    detected_columns    TEXT[],
    missing_columns     TEXT[],
    uploaded_at         TIMESTAMP DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLE : allowed_whatsapp_users
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowed_whatsapp_users (
    id                  SERIAL PRIMARY KEY,
    phone_number        TEXT UNIQUE NOT NULL,
    full_name           TEXT,
    role                TEXT NOT NULL DEFAULT 'viewer',  -- hr_admin | supervisor | viewer
    allowed_scope_type  TEXT,                -- plant | perimeter | process | circuit | group_name | area | null=all
    allowed_scope_value TEXT,                -- ex: 'G-855', 'Assembly', 'PGTF'
    language_pref       TEXT DEFAULT 'fr',   -- fr | ar | tn
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP DEFAULT NOW(),
    last_seen           TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_phone ON allowed_whatsapp_users(phone_number);

-- Données de démo
INSERT INTO allowed_whatsapp_users
    (phone_number, full_name, role, allowed_scope_type, allowed_scope_value, language_pref)
VALUES
    ('+21650505484', 'HR BMW U11 Bot',    'hr_admin',   NULL,           NULL,       'fr'),
    ('+21698000001', 'Responsable RH',    'hr_admin',   NULL,           NULL,       'fr'),
    ('+21698000002', 'Chef Assembly',     'supervisor', 'process',      'Assembly', 'tn'),
    ('+21698000003', 'Chef PGTF',         'supervisor', 'perimeter',    'PGTF',     'ar'),
    ('+21698000004', 'Chef G-855',        'supervisor', 'group_name',   'G-855',    'tn')
ON CONFLICT (phone_number) DO NOTHING;

-- ------------------------------------------------------------
-- VUE : résumé journalier par plant
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_daily_plant_summary AS
SELECT
    report_date,
    plant,
    SUM(actif)           AS actif,
    SUM(present)         AS present,
    SUM(np)              AS np,
    SUM(p)               AS p,
    SUM(sq)              AS sq,
    SUM(ac)              AS ac,
    SUM(rv)              AS rv,
    SUM(ml)              AS maladie,          -- ML = Maladie seulement
    SUM(md)              AS mise_en_demeure,  -- MD = Mise en demeure seulement
    SUM(total_abs)       AS total_abs,
    SUM(retard)          AS retard,
    SUM(heures_sup)      AS heures_sup,
    SUM(soll)            AS soll,
    SUM(ist)             AS ist,
    ROUND(SUM(ist) - SUM(soll), 2) AS delta,
    ROUND(SUM(np)      / NULLIF(SUM(actif), 0) * 100, 2) AS abs_np_rate,
    ROUND(SUM(p)       / NULLIF(SUM(actif), 0) * 100, 2) AS abs_p_rate,
    ROUND(SUM(present) / NULLIF(SUM(actif), 0) * 100, 2) AS taux_presence
FROM daily_hr_report
GROUP BY report_date, plant;

-- VUE : dernière date disponible
CREATE OR REPLACE VIEW v_latest_date AS
SELECT MAX(report_date) AS latest_date
FROM daily_hr_report;

DO $$
BEGIN
    RAISE NOTICE '✅ HR BMW U11 v2 — Base de données initialisée.';
    RAISE NOTICE '   ML = Maladie | MD = Mise en demeure (SÉPARÉS)';
END $$;
