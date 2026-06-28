#!/usr/bin/env node
// ================================================================
// HR BMW U11 — WhatsApp Chatbot (Baileys + Neon PostgreSQL)
// Usage: node chatbot_baileys.js
// Première fois: scannez le QR code avec WhatsApp du +216 28 995 222
// ================================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { Client } = require('pg');
const path = require('path');
const { useNeonAuthState } = require('./neon_auth_state');

// ── Config ───────────────────────────────────────────────────────
const AUTH_DIR = path.join(__dirname, 'whatsapp_auth');
// USE_NEON_AUTH=true → session stockée dans Neon (Koyeb/cloud)
// USE_NEON_AUTH=false → session stockée localement (PC/téléphone)
const USE_NEON_AUTH = process.env.USE_NEON_AUTH === 'true';
const NEON_URL = process.env.NEON_DATABASE_URL ||
  'postgresql://neondb_owner:npg_8aJpEbywQ6ZT@ep-tiny-glade-at3efk9k-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

// ── Neon DB ──────────────────────────────────────────────────────
let dbClient = null;

async function getDb() {
  if (dbClient) {
    try { await dbClient.query('SELECT 1'); return dbClient; } catch(e) { dbClient = null; }
  }
  dbClient = new Client({ connectionString: NEON_URL });
  await dbClient.connect();
  return dbClient;
}

async function dbQuery(sql, params = []) {
  const db = await getDb();
  const res = await db.query(sql, params);
  return res.rows;
}

// ══════════════════════════════════════════════════════════════════
// MOTEUR NLP DYNAMIQUE — HR BMW U11
// Lit toujours les données du dernier rapport uploadé
// ══════════════════════════════════════════════════════════════════

// ── 1. REGISTRE DES MÉTRIQUES ────────────────────────────────────
// Ordonné du plus spécifique au moins spécifique
// agg: SUM | RATE | SPECIAL | null(summary)
const METRIC_REGISTRY = [
  // Delta / Soll / IST
  { patterns:[/\bdelta\b|écart|ecart|ist[\s\-]*soll|soll[\s\-]*ist|différence|difference/],
    metric:'delta', col:'delta', selCols:'SUM(soll) AS soll,SUM(ist) AS ist,ROUND(SUM(ist)-SUM(soll),2) AS val,SUM(actif) AS actif',
    label:'Delta (IST−Soll)', unit:'h', agg:'SUM' },
  { patterns:[/\bsoll\b|objectif\b|target\b|planifi[eé]\b|prévu\b|prevu\b/],
    metric:'soll', col:'soll', selCols:'SUM(soll) AS val,SUM(ist) AS ist,ROUND(SUM(ist)-SUM(soll),2) AS delta,SUM(actif) AS actif',
    label:'Soll (Planifié)', unit:'h', agg:'SUM' },
  { patterns:[/\bist\b(?!\s*[a-z])|réalisé\b|realise\b|actuel\b(?!\s*(?:lement|s\b))/],
    metric:'ist', col:'ist', selCols:'SUM(ist) AS val,SUM(soll) AS soll,ROUND(SUM(ist)-SUM(soll),2) AS delta,SUM(actif) AS actif',
    label:'IST (Réalisé)', unit:'h', agg:'SUM' },

  // Taux
  { patterns:[/taux\s*np|%\s*np|taux\s*abs\s*np|pourcentage\s*np/],
    metric:'abs_np_rate', col:'np', selCols:'SUM(np) AS np,SUM(actif) AS actif,ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS val',
    label:'Taux NP', unit:'%', agg:'RATE' },
  { patterns:[/taux\s*\bp\b|taux\s*abs\s*p\b|pourcentage\s*\bp\b/],
    metric:'abs_p_rate', col:'p', selCols:'SUM(p) AS p,SUM(actif) AS actif,ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS val',
    label:'Taux P', unit:'%', agg:'RATE' },
  { patterns:[/taux\s*pr[eé]s|taux\s*presence|%\s*présence|taux\s*de\s*présence/],
    metric:'taux_presence', col:'present', selCols:'SUM(present) AS present,SUM(actif) AS actif,ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS val',
    label:'Taux Présence', unit:'%', agg:'RATE' },

  // ML / MD (avant "maladie" générique)
  { patterns:[/\bml\b|maladie\s*prol|مرض\s*طويل/],
    metric:'maladie', col:'ml', selCols:'SUM(ml) AS val',
    label:'ML (Maladie Prolongée)', unit:'', agg:'SUM' },
  { patterns:[/\bmd\b|mise\s*en\s*demeure|fluctuation|إنذار/],
    metric:'mise_en_demeure', col:'md', selCols:'SUM(md) AS val',
    label:'MD (Fluctuation/Mise en demeure)', unit:'', agg:'SUM' },

  // Heures
  { patterns:[/heures?\s*pr[eé]s|h\.pres\b|hpres\b|h\s*présence|heures?\s*trav|ساعات\s*حضور/],
    metric:'heures_presence', col:'heures_presence', selCols:'SUM(heures_presence) AS val,SUM(actif) AS actif',
    label:'Heures Présence', unit:'h', agg:'SUM' },
  { patterns:[/h\s*sup\b|heures?\s*sup|heures?\s*supp|overtime|ساعات\s*إضافية/],
    metric:'heures_sup', col:'heures_sup', selCols:'SUM(heures_sup) AS val',
    label:'Heures Sup', unit:'h', agg:'SUM' },

  // Absences spécifiques
  { patterns:[/\bnp\b|absence\s*np|non\s*planif|non\s*justif|غياب\s*np|غياب\s*غير\s*مبرر/],
    metric:'np', col:'np', selCols:'SUM(np) AS val,SUM(actif) AS actif,ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS pct',
    label:'Absence NP', unit:'', agg:'SUM' },
  { patterns:[/\bac\b|absence\s*continue/],
    metric:'ac', col:'ac', selCols:'SUM(ac) AS val',
    label:'AC', unit:'', agg:'SUM' },
  { patterns:[/\bsq\b|sans\s*questionnaire/],
    metric:'sq', col:'sq', selCols:'SUM(sq) AS val',
    label:'SQ', unit:'', agg:'SUM' },
  { patterns:[/\brv\b|renvoi\b/],
    metric:'rv', col:'rv', selCols:'SUM(rv) AS val',
    label:'RV (Renvoi)', unit:'', agg:'SUM' },
  { patterns:[/\bp\b(?!gtf|res|la|ou|ar|ar)|absence\s*p\b|planifi[eé]e?\b(?!\s*(?:heures|soll))|غياب\s*مبرر/],
    metric:'p', col:'p', selCols:'SUM(p) AS val,SUM(actif) AS actif,ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS pct',
    label:'Absence P', unit:'', agg:'SUM' },

  // Présents / Actif
  { patterns:[/\bpr[eé]sent|حضور\b/],
    metric:'present', col:'present', selCols:'SUM(present) AS val,SUM(actif) AS actif,ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS pct',
    label:'Présents', unit:'', agg:'SUM' },
  { patterns:[/\bactif\b|\beffectif\b|\bhc\b(?!\s*\d)|nombre\s*employ|nombre\s*op[eé]r|headcount/],
    metric:'actif', col:'actif', selCols:'SUM(actif) AS val,SUM(present) AS present',
    label:'Effectif Actif', unit:'', agg:'SUM' },
  { patterns:[/retard\b|late\b/],
    metric:'retard', col:'retard', selCols:'SUM(retard) AS val',
    label:'Retards', unit:'', agg:'SUM' },
  { patterns:[/\bmaladie\b/],
    metric:'maladie', col:'ml', selCols:'SUM(ml) AS val',
    label:'ML (Maladie Prolongée)', unit:'', agg:'SUM' },

  // Résumé
  { patterns:[/r[eé]sum[eé]|ملخص|tous\s*les\s*indicateurs|chiffres|kpi\b|bilan\b|overview|indicateurs\s*de/],
    metric:'summary', col:null, selCols:null,
    label:'Résumé Complet', unit:'', agg:null },

  // Total abs (fallback absences — DOIT être explicite dans la question)
  { patterns:[/total\s*abs|abs\s*total|absence\s*total|إجمالي\s*الغياب|total\s*absences/],
    metric:'total_abs', col:'total_abs', selCols:'SUM(total_abs) AS val,SUM(np) AS np,SUM(p) AS p,SUM(actif) AS actif',
    label:'Total Absences', unit:'', agg:'SUM' },
];

// Colonnes SELECT pour le résumé complet
const SUMMARY_COLS = `SUM(actif) AS actif,SUM(present) AS present,SUM(np) AS np,SUM(p) AS p,
  SUM(sq) AS sq,SUM(ac) AS ac,SUM(rv) AS rv,SUM(ml) AS maladie,SUM(md) AS mise_en_demeure,
  SUM(total_abs) AS total_abs,SUM(heures_presence) AS heures_presence,
  SUM(heures_sup) AS heures_sup,SUM(retard) AS retard,
  SUM(soll) AS soll,SUM(ist) AS ist,ROUND(SUM(ist)-SUM(soll),2) AS delta,
  ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate,
  ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate,
  ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence`;

// Métrique par défaut si un process/activite est détecté sans mot-clé métrique
const PROCESS_DEFAULT  = { metric:'delta', col:'delta',
  selCols:'SUM(soll) AS soll,SUM(ist) AS ist,ROUND(SUM(ist)-SUM(soll),2) AS val,SUM(actif) AS actif',
  label:'Delta/Soll/IST', unit:'h', agg:'SUM' };
const PROCESS_EFFECTIF = { metric:'actif', col:'actif',
  selCols:'SUM(actif) AS val,SUM(present) AS present',
  label:'Effectif Actif', unit:'', agg:'SUM' };

// ── 2. PATTERNS DE FILTRES ────────────────────────────────────────
const CIRCUIT_PATTERNS = [
  [/pgtf[\s\-]?1/i,'PGTF-1'],[/pgtf[\s\-]?2/i,'PGTF-2'],[/pgtf[\s\-]?3/i,'PGTF-3'],
  [/\bpgtf\b/i,'%PGTF%'],[/shelf/i,'Shelf'],[/\bwpa\b/i,'WPA'],[/\bbasis\b/i,'Basis'],
  [/rework|zone.?rework/i,'%ework%'],[/seg.?circuit/i,'Seg Circuit'],
  [/\bmuster\b/i,'Muster'],[/\bformation\b/i,'%ormation%'],[/non.?affect/i,'%Non%affect%'],
  [/\bcircuit\b(?!.*seg)/i,'Circuit'],
];
const PROCESS_ACT_PATTERNS = [
  [/electrical\s*test|elec\s*test|test\s*electr/i,'Electrical Test'],
  [/\bassembl/i,'Assembly'],[/\bce\b|câblag|cablag/i,'CE'],
  [/rework|retravail/i,'Rework'],[/manutent/i,'Manutention'],
  [/visual|controle.?vis/i,'Visual'],[/logistic|logistiq/i,'Logistique'],
  [/\btest\b(?!\s*(electr|soll|ist|delta|clé|kpi))/i,'Test'],
];
const AREA_PATTERNS = [
  [/mabrouk|abdelhamid|ho\s*1|area\s*1|zone\s*pgtf/i,'%mabrouk%'],
  [/laarabi|laarbi|mustpha|moustfa|ho\s*2|area\s*2|zone\s*(shelf|wpa|basis)/i,'%laarabi%'],
];

// ── 3. FONCTIONS DE BASE ──────────────────────────────────────────
function normalizeText(text) {
  return text.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g,'')  // supprimer accents
    .replace(/[''`]/g,"'").replace(/\s+/g,' ').trim();
}

function detectLang(raw) {
  if (/[؀-ۿ]/.test(raw)) return 'ar';
  const tn = ['a3tini','9adech','chnowa','chkoun','mta3','lyoum','barsha','waqteh','akther','fih','bech','3andek'];
  if (tn.some(w => raw.toLowerCase().includes(w))) return 'tn';
  return 'fr';
}

// ── 4. DÉTECTION DATE ────────────────────────────────────────────
function detectDate(n) {
  const iso = n.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return { mode:'specific', date:iso[0] };
  const dmy = n.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (dmy) return { mode:'specific', date:`${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}` };
  if (/aujourd|lyoum|اليوم|today/.test(n)) return { mode:'latest' };
  if (/hier|امس|yesterday/.test(n))        return { mode:'yesterday' };
  return { mode:'latest' };
}

function detectTwoDates(n) {
  const found = [];
  const dmyRe = /(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{4}))?/g;
  let m;
  while ((m = dmyRe.exec(n)) !== null) {
    const y = m[3] || String(new Date().getFullYear());
    found.push(`${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  }
  const isoRe = /(\d{4}-\d{2}-\d{2})/g;
  while ((m = isoRe.exec(n)) !== null) { if (!found.includes(m[1])) found.push(m[1]); }
  if (found.length >= 2) return { date1:found[0], date2:found[1] };
  return null;
}

// ── 5. DÉTECTION MÉTRIQUE ────────────────────────────────────────
function mapMetricToColumn(n) {
  for (const entry of METRIC_REGISTRY) {
    if (entry.patterns.some(re => re.test(n))) return entry;
  }
  return null; // aucune métrique spécifique trouvée
}

// ── 6. DÉTECTION FILTRES ─────────────────────────────────────────
function detectFilters(n) {
  const filters = { group:null, circuit:null, activite:null, area:null };
  // Groupe G-XXX
  const g = n.match(/\b(g[-.]?\d{3,4}(?:[-.]?\d)?)\b/i);
  if (g) filters.group = g[0].replace(/\./g,'-').toUpperCase();
  // Circuit / Zone
  for (const [re, val] of CIRCUIT_PATTERNS) { if (re.test(n)) { filters.circuit = val; break; } }
  // Process / Activité
  for (const [re, val] of PROCESS_ACT_PATTERNS) { if (re.test(n)) { filters.activite = val; break; } }
  // Area (responsable)
  for (const [re, val] of AREA_PATTERNS) { if (re.test(n)) { filters.area = val; break; } }
  return filters;
}

// ── 7. DÉTECTION INTENTION ───────────────────────────────────────
function detectIntent(n, metricDef) {
  if (!metricDef) return 'get_metric';
  if (metricDef.metric === 'summary') return 'summary';
  if (/best\s*employ|أفضل\s*عامل|critere.*best|meilleur.*employ/.test(n)) return 'best_employee';
  if (/best\s*team|أفضل\s*فريق|critere.*best.*team|meilleur.*equipe/.test(n)) return 'best_team';
  if (/\btop\b|classement|le\s*plus|plus.*abs|le.*plus.*grand/.test(n)) return 'top';
  if (/compar|evolution|vs\b|entre.*et|n-1|jour.*(precedent|avant)/.test(n)) return 'compare';
  if (/groupe.*de\s*(shelf|wpa|basis|pgtf)|chaque\s*groupe|tous\s*les\s*groupe|par\s*groupe/.test(n)) return 'list_group';
  if (/chaque\s*(area|ho)|par\s*(area|ho)|tous\s*les\s*(area|ho)/.test(n)) return 'list_area';
  if (/par\s*pgtf|pgtf.*(1.*2|detail)|chaque\s*(process|circuit)|par\s*(process|circuit)/.test(n)) return 'list_circuit';
  return 'get_metric';
}

// ── 8. CONSTRUCTION SQL DYNAMIQUE ────────────────────────────────
function dateExprSQL(mode, date) {
  if (mode === 'specific' && date) return `'${date}'::date`;
  if (mode === 'yesterday') return "CURRENT_DATE - INTERVAL '1 day'";
  return '(SELECT MAX(report_date) FROM daily_hr_report)';
}

function buildScopeLabel(filters) {
  const parts = [];
  if (filters.activite) parts.push(filters.activite);
  if (filters.group)    parts.push(filters.group);
  else if (filters.circuit) parts.push(filters.circuit.replace(/%/g,'').trim());
  else if (filters.area)    parts.push(filters.area.replace(/%/g,'').trim());
  else parts.push('BMW U11');
  return parts.join(' — ');
}

function buildDynamicSQL(filters, metricDef, intent, dateMode, dateVal) {
  const dateExpr = dateExprSQL(dateMode, dateVal);
  const safe = v => (v||'').replace(/'/g,"''");

  // Construire le WHERE
  const where = [
    `plant ILIKE 'BMW U11'`,
    `report_date = ${dateExpr}`,
    filters.group    ? `group_name ILIKE '${safe(filters.group)}'`   : null,
    filters.circuit  ? `circuit ILIKE '${safe(filters.circuit)}'`     : null,
    filters.activite ? `activite ILIKE '${safe(filters.activite)}'`   : null,
    filters.area     ? `process ILIKE '${safe(filters.area)}'`        : null,
  ].filter(Boolean).join(' AND ');

  // Colonnes SELECT
  const selCols = metricDef.metric === 'summary' ? SUMMARY_COLS : metricDef.selCols;

  // Colonnes SELECT pour liste (besoin d'un alias 'val' pour ORDER BY)
  const listSelCols = metricDef.metric === 'summary'
    ? `SUM(total_abs) AS val, ${SUMMARY_COLS}`
    : (metricDef.selCols.includes('AS val') ? metricDef.selCols : `${metricDef.selCols},SUM(total_abs) AS val`);

  // ── LISTE : par groupe / area / circuit ───────────────────────
  if (['list_group','list_area','list_circuit'].includes(intent)) {
    const groupCol = intent==='list_group'? 'group_name' : intent==='list_area'? 'process' : 'circuit';
    return `SELECT report_date, ${groupCol} AS scope_label, ${listSelCols}
      FROM daily_hr_report WHERE ${where}
      GROUP BY report_date, ${groupCol}
      ORDER BY val DESC NULLS LAST LIMIT 30`;
  }

  // ── TOP 5 ─────────────────────────────────────────────────────
  if (intent === 'top') {
    return `SELECT report_date, group_name AS scope_label, ${listSelCols}
      FROM daily_hr_report WHERE ${where}
      GROUP BY report_date, group_name
      ORDER BY val DESC NULLS LAST LIMIT 5`;
  }

  // ── GET_METRIC / SUMMARY : agréger ────────────────────────────
  const groupByCol = filters.group    ? 'group_name'
                   : filters.circuit  ? 'circuit'
                   : filters.area     ? 'process'
                   : 'plant';
  return `SELECT report_date, ${groupByCol} AS scope_label, ${selCols}
    FROM daily_hr_report WHERE ${where}
    GROUP BY report_date, ${groupByCol}`;
}

// ── 9. FORMATAGE ─────────────────────────────────────────────────
function fmt(v, dec=1) { return v==null ? 'N/D' : Number(v).toFixed(dec); }
function fmtDate(d) {
  if (!d) return 'N/D';
  try { return new Date(d).toLocaleDateString('fr-TN',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  catch(e) { return String(d); }
}

function formatAnswer(rows, filters, metricDef, intent, lang, debugInfo) {
  const scopeLabel = buildScopeLabel(filters);
  const metric = metricDef.metric;

  // ── Aucune donnée ─────────────────────────────────────────────
  if (!rows || rows.length === 0) {
    const filterDesc = [
      filters.group    ? `Groupe: ${filters.group}` : null,
      filters.circuit  ? `Circuit: ${filters.circuit}` : null,
      filters.activite ? `Activité: ${filters.activite}` : null,
      filters.area     ? `Area: ${filters.area}` : null,
    ].filter(Boolean).join(' | ') || 'BMW U11 complet';

    return `⚠️ *Aucune donnée — ${metricDef.label}*\n\n` +
      `🔍 Filtres appliqués : ${filterDesc}\n` +
      `📅 Rapport : ${dateExprSQL('latest','') === dateExprSQL('latest','') ? 'dernier disponible' : ''}\n\n` +
      `Causes possibles :\n` +
      `• Rapport pas encore uploadé\n` +
      (filters.activite ? `• Champ "activite" vide dans HTML (re-uploader après fix web_upload.js)\n` : '') +
      `• Filtre trop restrictif\n\n` +
      `💡 Tapez "résumé BMW U11" pour voir toutes les données disponibles` +
      (debugInfo ? `\n\n🔧 DEBUG: ${debugInfo}` : '');
  }

  // Agréger toutes les lignes retournées
  const agg = {};
  for (const r of rows) {
    for (const [k,v] of Object.entries(r)) {
      if (k === 'report_date' || k === 'scope_label') { agg[k] = agg[k] || v; continue; }
      agg[k] = (agg[k]||0) + (parseFloat(v)||0);
    }
  }
  // Recalculer delta si nécessaire
  if (agg.soll != null && agg.ist != null && !agg.val && metric === 'delta') {
    agg.val = agg.ist - agg.soll;
  }
  const dl = fmtDate(agg.report_date);
  const val = agg.val ?? 0;
  const unit = metricDef.unit;
  const d = (agg.delta||agg.val||0) >= 0 ? '+' : '';

  // ── Résumé complet ────────────────────────────────────────────
  if (metric === 'summary') {
    const np_pct  = agg.actif ? fmt(agg.np/agg.actif*100)    : fmt(agg.abs_np_rate||0);
    const p_pct   = agg.actif ? fmt(agg.p/agg.actif*100)     : fmt(agg.abs_p_rate||0);
    const pres_pct= agg.actif ? fmt(agg.present/agg.actif*100): fmt(agg.taux_presence||0);
    const deltaV  = agg.delta ?? (agg.ist - agg.soll);
    const ds = deltaV >= 0 ? '+' : '';
    if (lang === 'ar') {
      return `📊 *ملخص ${scopeLabel}*\n📅 ${dl}\n\n` +
        `👥 الأعداد: ${fmt(agg.actif,0)} | حاضرون: ${fmt(agg.present,0)} (${pres_pct}%)\n` +
        `❌ NP: ${fmt(agg.np,0)} (${np_pct}%) | 🗓️ P: ${fmt(agg.p,0)} (${p_pct}%)\n` +
        `📊 إجمالي غياب: ${fmt(agg.total_abs,0)}\n` +
        `📋 SQ:${fmt(agg.sq,0)} | AC:${fmt(agg.ac,0)} | RV:${fmt(agg.rv,0)}\n` +
        `🏥 ML:${fmt(agg.maladie,0)} | 🚪 MD:${fmt(agg.mise_en_demeure,0)}\n` +
        `⚖️ Delta: ${ds}${fmt(deltaV)}h | ⏱️ H.Sup:${fmt(agg.heures_sup,0)}h`;
    }
    return `📊 *Résumé — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `👥 Actif: *${fmt(agg.actif,0)}* | Présents: *${fmt(agg.present,0)}* (${pres_pct}%)\n\n` +
      `❌ NP: *${fmt(agg.np,0)}* (${np_pct}%) | 🗓️ P: *${fmt(agg.p,0)}* (${p_pct}%)\n` +
      `📊 Total Abs: *${fmt(agg.total_abs,0)}*\n\n` +
      `📋 SQ: ${fmt(agg.sq,0)} | AC: ${fmt(agg.ac,0)} | RV: ${fmt(agg.rv,0)}\n` +
      `🏥 ML: ${fmt(agg.maladie,0)} | 🚪 MD: ${fmt(agg.mise_en_demeure,0)}\n\n` +
      `🎯 Soll: ${fmt(agg.soll,1)}h | ✅ IST: ${fmt(agg.ist,1)}h | ⚖️ Delta: ${ds}${fmt(deltaV,1)}h\n` +
      `⏱️ H.Sup: ${fmt(agg.heures_sup,0)}h | 🕐 H.Pres: ${fmt(agg.heures_presence,0)}h\n` +
      `⏰ Retards: ${fmt(agg.retard,0)}`;
  }

  // ── Process / Activité : carte dédiée ─────────────────────────
  if (filters.activite) {
    if (metric === 'delta' || metric === 'soll' || metric === 'ist') {
      const hasSollIst = agg.soll > 0 || agg.ist > 0;
      if (!hasSollIst) {
        return `⚠️ *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
          `Soll=${fmt(agg.soll,1)}h / IST=${fmt(agg.ist,1)}h (données = 0)\n\n` +
          `💡 Les colonnes Soll/IST sont vides. Actions :\n` +
          `1. Vérifier la console upload (champs disponibles dans HTML)\n` +
          `2. Re-uploader le rapport — web_upload.js cherche : soll, ist, soll_h, ist_h, planifie, reel\n` +
          `3. Si champs différents, me communiquer les vrais noms`;
      }
      const deltaCalc = (agg.ist||0) - (agg.soll||0);
      const ds = deltaCalc >= 0 ? '+' : '';
      return `📊 *Process ${scopeLabel}*\n📅 ${dl}\n\n` +
        `🎯 Soll  = *${fmt(agg.soll,1)}h*\n` +
        `✅ IST   = *${fmt(agg.ist,1)}h*\n` +
        `⚖️ Delta = *${ds}${fmt(deltaCalc,1)}h*\n` +
        `👥 Actif = ${fmt(agg.actif,0)}`;
    }
    if (metric === 'actif') {
      return `👥 *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
        `👥 Nombre (Actif) = *${fmt(val,0)}*\n` +
        `✅ Présents       = ${fmt(agg.present,0)}\n` +
        (agg.actif ? `📈 Taux présence  = ${fmt(agg.present/agg.actif*100)}%` : '');
    }
  }

  // ── Delta / Soll / IST standard ───────────────────────────────
  if (metric === 'delta' || metric === 'soll' || metric === 'ist') {
    const deltaCalc = (agg.ist||0) - (agg.soll||0);
    const ds = deltaCalc >= 0 ? '+' : '';
    return `⚖️ *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `🎯 Soll  = *${fmt(agg.soll,1)}h*\n` +
      `✅ IST   = *${fmt(agg.ist,1)}h*\n` +
      `⚖️ Delta = *${ds}${fmt(deltaCalc,1)}h*\n` +
      `👥 Actif = ${fmt(agg.actif,0)}`;
  }

  // ── Taux ──────────────────────────────────────────────────────
  if (metric === 'abs_np_rate' || metric === 'abs_p_rate' || metric === 'taux_presence') {
    const rate = agg.val ?? (agg.num_val && agg.den_val ? agg.num_val/agg.den_val*100 : 0);
    return `📊 *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `📉 ${metricDef.label} = *${fmt(rate)}%*\n` +
      (agg.np   != null ? `   NP: ${fmt(agg.np,0)}` : '') +
      (agg.p    != null ? ` | P: ${fmt(agg.p,0)}`   : '') +
      (agg.actif         ? `\n👥 Actif: ${fmt(agg.actif,0)}`  : '');
  }

  // ── NP / P avec taux ──────────────────────────────────────────
  if (metric === 'np' || metric === 'p') {
    const emoji = metric === 'np' ? '❌' : '🗓️';
    const pct = agg.actif ? fmt(val/agg.actif*100) : fmt(agg.pct||0);
    return `${emoji} *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `${emoji} ${metricDef.label} = *${fmt(val,0)}*\n` +
      `📉 Taux = ${pct}%\n` +
      `👥 Actif = ${fmt(agg.actif,0)}`;
  }

  // ── Présents ──────────────────────────────────────────────────
  if (metric === 'present') {
    const pct = agg.actif ? fmt(val/agg.actif*100) : fmt(agg.pct||0);
    return `✅ *Présents — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `✅ Présents = *${fmt(val,0)}*\n` +
      `📈 Taux = ${pct}%\n` +
      `👥 Actif = ${fmt(agg.actif,0)}`;
  }

  // ── Actif ─────────────────────────────────────────────────────
  if (metric === 'actif') {
    return `👥 *Effectif Actif — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `👥 Actif = *${fmt(val,0)}*\n` +
      `✅ Présents = ${fmt(agg.present,0)}`;
  }

  // ── Total Abs ─────────────────────────────────────────────────
  if (metric === 'total_abs') {
    const np_pct = agg.actif ? fmt(agg.np/agg.actif*100) : '0.0';
    const p_pct  = agg.actif ? fmt(agg.p/agg.actif*100)  : '0.0';
    return `📊 *Total Absences — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `👥 Actif : ${fmt(agg.actif,0)}\n` +
      `❌ NP : *${fmt(agg.np,0)}* (${np_pct}%) | 🗓️ P : *${fmt(agg.p,0)}* (${p_pct}%)\n` +
      `📊 Total Abs = *${fmt(val,0)}*`;
  }

  // ── Heures présence ───────────────────────────────────────────
  if (metric === 'heures_presence') {
    return `🕐 *Heures Présence — ${scopeLabel}*\n📅 ${dl}\n\n` +
      `🕐 H.Présence = *${fmt(val,1)}h*\n` +
      (agg.actif ? `👥 Actif = ${fmt(agg.actif,0)}` : '');
  }

  // ── Générique (ML, MD, SQ, AC, RV, Retard, H.Sup) ────────────
  const emojis = { maladie:'🏥',mise_en_demeure:'⚠️',sq:'📋',ac:'🔁',rv:'📌',
                   retard:'⏰',heures_sup:'⏱️' };
  const emoji2 = emojis[metric] || '📊';
  return `${emoji2} *${metricDef.label} — ${scopeLabel}*\n📅 ${dl}\n\n` +
    `${emoji2} ${metricDef.label} = *${fmt(val,0)}${unit}*`;
}

function formatList(rows, metricDef, intent, lang) {
  if (!rows || rows.length === 0)
    return `⚠️ Aucune donnée disponible.\nVérifiez que le rapport a été importé.`;
  const groupLabel = {list_group:'Groupe',list_area:'Area (HO)',list_circuit:'Circuit/Process'}[intent]||'Scope';
  const dl = rows[0]?.report_date ? fmtDate(rows[0].report_date) : '';
  const metric = metricDef.metric;

  const lines = rows.filter(r=>r.scope_label).map((r,i)=>{
    const label = r.scope_label;
    if (metric === 'delta' || metric === 'soll' || metric === 'ist') {
      const ds = (parseFloat(r.delta)||0) >= 0 ? '+' : '';
      return `  ${i+1}. *${label}*\n     Soll=${fmt(r.soll,1)}h | IST=${fmt(r.ist,1)}h | Δ=${ds}${fmt(r.delta,1)}h`;
    }
    if (metric === 'summary') {
      const pct = r.actif ? fmt(r.np/r.actif*100) : '0.0';
      return `  ${i+1}. *${label}* — NP:${fmt(r.np,0)} P:${fmt(r.p,0)} | Taux NP:${pct}% | Actif:${fmt(r.actif,0)}`;
    }
    const v = parseFloat(r.val)||0;
    const unit = metricDef.unit;
    const actif = r.actif ? ` / ${fmt(parseFloat(r.actif),0)} actif` : '';
    const pct   = (r.pct)  ? ` (${fmt(r.pct)}%)` : '';
    return `  ${i+1}. *${label}* : ${fmt(v)}${unit}${pct}${actif}`;
  }).join('\n');

  return `📊 *${metricDef.label} — par ${groupLabel}*\n📅 ${dl}\n\n${lines}`;
}

function formatComparison(rows1, rows2, dates, metricDef, scopeLabel, lang) {
  const d1 = fmtDate(dates.date1), d2 = fmtDate(dates.date2);
  const metric = metricDef.metric;

  // Agréger
  const agg = (rows) => {
    if (!rows || rows.length === 0) return null;
    const a = {};
    for (const r of rows) {
      for (const [k,v] of Object.entries(r)) {
        if (k==='report_date'||k==='scope_label') { a[k]=a[k]||v; continue; }
        a[k]=(a[k]||0)+(parseFloat(v)||0);
      }
    }
    if (a.soll!=null && a.ist!=null) a.delta = a.ist - a.soll;
    return a;
  };
  const a1 = agg(rows1), a2 = agg(rows2);

  const getVal = a => {
    if (!a) return null;
    if (metric==='delta') return a.delta ?? (a.ist-a.soll);
    if (metric==='abs_np_rate') return a.actif ? a.np/a.actif*100 : 0;
    if (metric==='abs_p_rate')  return a.actif ? a.p/a.actif*100  : 0;
    if (metric==='taux_presence') return a.actif ? a.present/a.actif*100 : 0;
    return a.val ?? a[metricDef.col] ?? 0;
  };

  const v1 = getVal(a1), v2 = getVal(a2);
  const isPct = ['abs_np_rate','abs_p_rate','taux_presence'].includes(metric);
  const unit = metricDef.unit;
  const diff = (v1!=null && v2!=null) ? v2-v1 : null;
  const arrow = diff==null?'➡️':diff>0?'📈':diff<0?'📉':'➡️';
  const sign  = diff>=0?'+':'';

  // Percentage of total for count metrics
  const getPct = (a, v) => {
    if (!a?.actif) return null;
    if (['np','p','total_abs','present'].includes(metric)) return v/a.actif*100;
    return null;
  };
  const pct1 = !isPct ? getPct(a1,v1) : null;
  const pct2 = !isPct ? getPct(a2,v2) : null;
  const pctDiff = (pct1!=null&&pct2!=null) ? pct2-pct1 : null;

  const v1Str = v1!=null ? `${fmt(v1)}${unit}` : 'N/D';
  const v2Str = v2!=null ? `${fmt(v2)}${unit}` : 'N/D';
  const p1Str = pct1!=null ? ` (${fmt(pct1)}%)` : '';
  const p2Str = pct2!=null ? ` (${fmt(pct2)}%)` : '';
  const evolStr = diff!=null ? `${sign}${fmt(diff)}${unit}` : 'N/D';
  const evolPStr= pctDiff!=null ? ` (${pctDiff>=0?'+':''}${fmt(pctDiff)}%)` : '';
  const actif1 = a1?.actif||0, actif2 = a2?.actif||0;
  const actifStr = (actif1>0||actif2>0) ? `\n👥 Actif : ${fmt(actif1,0)} → ${fmt(actif2,0)}` : '';

  // Delta special: show soll+ist
  let extra = '';
  if (metric === 'delta' || metric === 'soll' || metric === 'ist') {
    extra = `\n\n📋 Détail:\n` +
      `  Soll : ${fmt(a1?.soll,1)}h → ${fmt(a2?.soll,1)}h\n` +
      `  IST  : ${fmt(a1?.ist,1)}h → ${fmt(a2?.ist,1)}h`;
  }

  return `📊 *Comparaison ${metricDef.label} — ${scopeLabel}*\n\n` +
    `📅 ${d1} : *${v1Str}*${p1Str}\n` +
    `📅 ${d2} : *${v2Str}*${p2Str}\n\n` +
    `${arrow} Évolution : ${evolStr}${evolPStr}${actifStr}${extra}`;
}

// ── 10. RÉPONSES STATIQUES ────────────────────────────────────────
function getBestEmployeeMsg() {
  return `🏆 *Critères Best Employee — BMW U11*\n\n` +
    `*🥇 Meilleur Employé du Mois :*\n` +
    `✅ NON éliminatoires :\n` +
    `  • Polyvalence\n  • ≥ 2 idées amélioration continue\n` +
    `  • Objectifs Efficience atteints\n  • Objectifs Qualité atteints\n\n` +
    `❌ Éliminatoires :\n` +
    `  • Absence non justifiée\n  • ≥ 1 absence justifiée\n` +
    `  • Retard\n  • Sanction disciplinaire\n  • Ancienneté < 3 mois\n  • Oubli de pointage\n\n` +
    `*🥇 Meilleur Employé de l'Année :*\n` +
    `✅ NON éliminatoires :\n` +
    `  • Polyvalence\n  • ≥ 3 idées amélioration continue\n` +
    `  • Objectifs Efficience atteints\n  • Objectifs Qualité atteints\n\n` +
    `❌ Éliminatoires :\n` +
    `  • Absence non justifiée\n  • ≥ 4 absences justifiées\n` +
    `  • ≥ 3 retards\n  • Sanction disciplinaire\n  • Ancienneté < 1 an\n  • ≥ 2 oublis de pointage`;
}

function getBestTeamMsg() {
  return `🏆 *Critères Best Team — BMW U11*\n\n` +
    `✅ Performance collective :\n` +
    `  • Taux de présence élevé\n  • Zéro absence NP dans l'équipe\n` +
    `  • Objectifs Qualité & Efficience atteints\n  • Participation aux idées d'amélioration\n\n` +
    `❌ Éliminatoires équipe :\n` +
    `  • Absence non justifiée dans l'équipe\n  • Sanction disciplinaire membre\n` +
    `  • Objectifs non atteints\n\n` +
    `Pour consulter les données d'un groupe : _Ex: résumé G-852_`;
}

// ── 11. TRAITEMENT MESSAGE ────────────────────────────────────────
async function processMessage(sock, jid, text) {
  const raw  = text.trim();
  const n    = normalizeText(raw);
  const lang = detectLang(raw);
  const phone= '+' + jid.replace('@s.whatsapp.net','').replace('@c.us','').replace(/\D/g,'');

  // DEBUG log
  console.log(`\n💬 [${phone}] "${raw}"`);
  console.log(`   🔤 Normalisé: "${n}"`);

  // ── Réponses statiques ────────────────────────────────────────
  if (/best\s*employ|أفضل\s*عامل|critere.*best\s*employ|meilleur.*employ/.test(n)) {
    await sock.sendMessage(jid, { text: getBestEmployeeMsg() }); return;
  }
  if (/best\s*team|أفضل\s*فريق|critere.*best.*team|meilleur.*equipe/.test(n)) {
    await sock.sendMessage(jid, { text: getBestTeamMsg() }); return;
  }

  // ── NLP Pipeline ──────────────────────────────────────────────
  const dateInfo  = detectDate(n);
  const filters   = detectFilters(n);
  let   metricDef = mapMetricToColumn(n);
  const intent    = detectIntent(n, metricDef);

  // Si process détecté mais aucune métrique → override intelligent
  if (filters.activite && !metricDef) {
    const askNombre = /nombre|effectif|combien|nbre|how\s*many|عدد|كم/.test(n);
    metricDef = askNombre ? PROCESS_EFFECTIF : PROCESS_DEFAULT;
    console.log(`   🔄 Process override → ${metricDef.metric}`);
  }

  // Si toujours pas de métrique → demander une précision
  if (!metricDef) {
    const available = `NP, P, Total Abs, Actif, Présents, Taux NP, Taux P, Taux Présence, ` +
      `Soll, IST, Delta, H.Présence, H.Sup, ML, MD, SQ, AC, RV, Retard, Résumé`;
    const scopeDesc = buildScopeLabel(filters);
    await sock.sendMessage(jid, { text:
      `❓ Je n'ai pas compris l'indicateur demandé pour *${scopeDesc}*.\n\n` +
      `📊 Indicateurs disponibles :\n${available}\n\n` +
      `Exemples :\n` +
      `• "Absence NP pour PGTF"\n• "Résumé G-856"\n• "Delta PGTF"\n• "Actif Shelf"`
    }); return;
  }

  // DEBUG
  console.log(`   📊 Intent: ${intent} | Metric: ${metricDef.metric} | Lang: ${lang}`);
  console.log(`   🔍 Filtres: groupe=${filters.group||'—'} circuit=${filters.circuit||'—'} activite=${filters.activite||'—'} area=${filters.area||'—'}`);
  console.log(`   📅 Date: ${dateInfo.mode}${dateInfo.date?' ('+dateInfo.date+')':''}`);

  // ── Comparaison deux dates ────────────────────────────────────
  if (intent === 'compare') {
    const twoDates = detectTwoDates(n);
    const scopeLabel = buildScopeLabel(filters);
    const makeNlp = (dateMode, dateVal) => ({ ...filters, dateMode, dateVal });

    if (twoDates) {
      const sql1 = buildDynamicSQL(filters, metricDef, 'get_metric', 'specific', twoDates.date1);
      const sql2 = buildDynamicSQL(filters, metricDef, 'get_metric', 'specific', twoDates.date2);
      const [r1, r2] = await Promise.all([dbQuery(sql1), dbQuery(sql2)]);
      const response = formatComparison(r1, r2, twoDates, metricDef, scopeLabel, lang);
      await sock.sendMessage(jid, { text: response });
    } else {
      const datesRows = await dbQuery(`SELECT DISTINCT report_date FROM daily_hr_report WHERE plant ILIKE 'BMW U11' ORDER BY report_date DESC LIMIT 2`);
      if (datesRows.length >= 2) {
        const d1 = datesRows[1].report_date.toISOString().slice(0,10);
        const d2 = datesRows[0].report_date.toISOString().slice(0,10);
        const sql1 = buildDynamicSQL(filters, metricDef, 'get_metric', 'specific', d1);
        const sql2 = buildDynamicSQL(filters, metricDef, 'get_metric', 'specific', d2);
        const [r1, r2] = await Promise.all([dbQuery(sql1), dbQuery(sql2)]);
        const response = formatComparison(r1, r2, {date1:d1,date2:d2}, metricDef, scopeLabel, lang);
        await sock.sendMessage(jid, { text: response });
      }
    }
    console.log(`   ✅ Comparaison envoyée`);
    return;
  }

  // ── Requête principale ────────────────────────────────────────
  const sql  = buildDynamicSQL(filters, metricDef, intent, dateInfo.mode, dateInfo.date);
  console.log(`   🗄️ SQL: ${sql.replace(/\s+/g,' ').substring(0,150)}...`);

  const rows = await dbQuery(sql);
  console.log(`   📋 ${rows.length} ligne(s) trouvée(s)`);

  let response;
  if (['list_group','list_area','list_circuit','top'].includes(intent)) {
    response = formatList(rows, metricDef, intent, lang);
  } else {
    response = formatAnswer(rows, filters, metricDef, intent, lang, null);
  }

  await sock.sendMessage(jid, { text: response });
  console.log(`   ✅ Réponse envoyée`);
}
// ── Bot Baileys ──────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = USE_NEON_AUTH
    ? await useNeonAuthState()
    : await useMultiFileAuthState(AUTH_DIR);
  console.log(USE_NEON_AUTH ? '☁️  Auth: Neon PostgreSQL' : '💾 Auth: Fichiers locaux');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['HR BMW U11 Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Scannez ce QR code avec WhatsApp du +216 28 995 222:\n');
      qrcode.generate(qr, { small: true });
      try {
        const QRCode = require('qrcode');
        const qrPath = '/sdcard/Download/whatsapp_qr.png';
        await QRCode.toFile(qrPath, qr);
        console.log('📱 QR sauvegardé: ' + qrPath);
        console.log('👉 Ouvrez la Galerie → whatsapp_qr.png → scannez avec WhatsApp de +216 28 995 222');
      } catch(e) {
        console.log('⚠️ PNG non généré (normal sur PC):', e.message);
      }
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode : undefined;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('🔌 Connexion fermée. Reconnexion:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connecté ! Bot prêt à recevoir des messages.\n');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Ignorer messages envoyés par le bot
      if (msg.key.fromMe) continue;
      // Ignorer messages de groupe
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;

      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';

      if (!text.trim()) continue;

      try {
        await processMessage(sock, msg.key.remoteJid, text);
      } catch (err) {
        console.error('❌ Erreur traitement:', err.message);
        if (err.message?.includes('connection')) dbClient = null;
      }
    }
  });

  return sock;
}

// ── Démarrage ────────────────────────────────────────────────────
console.log('🤖 HR BMW U11 WhatsApp Chatbot (Baileys)');
console.log('   Sans limite, sans quota, 100% gratuit\n');
startBot().catch(console.error);
