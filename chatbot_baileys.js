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

// ── NLP ──────────────────────────────────────────────────────────
function detectLang(t) {
  if (/[؀-ۿ]/.test(t)) return 'ar';
  const tn = ['a3tini','9adech','chnowa','chkoun','mta3','lyoum','barsha','waqteh','akther','fih','bech','3andek'];
  if (tn.some(w => t.includes(w))) return 'tn';
  return 'fr';
}

function detectDate(t) {
  const iso = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return { mode: 'specific', date: iso[0] };
  const dmy = t.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (dmy) return { mode: 'specific', date: `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}` };
  if (/aujourd|lyoum|اليوم|today/.test(t)) return { mode: 'latest' };
  if (/hier|امس|yesterday/.test(t)) return { mode: 'yesterday' };
  return { mode: 'latest' };
}

function detectMetric(t) {
  if (/taux.*np|pourcentage.*np|taux abs np|abs np rate/.test(t)) return 'abs_np_rate';
  if (/taux.*\bp\b|taux abs p|abs p rate/.test(t)) return 'abs_p_rate';
  if (/taux.*pré|taux.*presence/.test(t)) return 'taux_presence';
  if (/\bnp\b|absence np|non plan/.test(t)) return 'np';
  if (/\bp\b|absence planif|abs p/.test(t) && !/np/.test(t)) return 'p';
  if (/\bsq\b|sans questionnaire/.test(t)) return 'sq';
  if (/\bac\b|absence continue/.test(t)) return 'ac';
  if (/\brv\b|rendez.vous/.test(t)) return 'rv';
  // ML = Maladie Prolongée SEULEMENT — jamais mélanger avec MD
  if (/\bml\b|maladie prol|مرض طويل|مرض مطوّل/.test(t) && !/mise en demeure|\bmd\b|quitt|démiss/.test(t)) return 'maladie';
  if (/maladie/.test(t) && !/mise en demeure|\bmd\b|quitt|démiss/.test(t)) return 'maladie';
  // MD = Mise en demeure (quittement) SEULEMENT — jamais mélanger avec ML
  if (/\bmd\b|mise en demeure|quitt|démiss|إنذار|إنهاء عقد/.test(t)) return 'mise_en_demeure';
  if (/\bdelta\b|soll.*ist|ist.*soll|écart/.test(t)) return 'delta';
  if (/h.*sup|heures sup/.test(t)) return 'heures_sup';
  if (/heures.*pré|heures.*pres|h\.pres|hpres|وقت الحضور|ساعات الحضور/.test(t)) return 'heures_presence';
  if (/retard/.test(t)) return 'retard';
  if (/actif|effectif/.test(t) && !/absence/.test(t)) return 'actif';
  if (/présent|present/.test(t) && !/taux/.test(t)) return 'present';
  if (/résumé|resume|ملخص|tous.*indicateurs|chiffres/.test(t)) return 'summary';
  return 'total_abs';
}

function detectProcess(t) {
  if (/assembly|assemblage|montage/.test(t)) return 'ASSEMBLY';
  if (/press|presse/.test(t)) return 'PRESS';
  if (/body|caisse/.test(t)) return 'BODY';
  if (/paint|peinture/.test(t)) return 'PAINT';
  if (/logistic|logistique/.test(t)) return 'LOGISTIC';
  if (/quality|qualité/.test(t)) return 'QUALITY';
  if (/maintenance/.test(t)) return 'MAINTENANCE';
  return null;
}

function detectScope(t) {
  const g = t.match(/\b(g[-.]?\d{3,4})\b/i);
  const process = detectProcess(t);
  if (g) return { type: 'group_name', value: g[0].replace(/[\s.]/g,'-').toUpperCase(), process };
  return { type: 'plant', value: 'BMW U11', process };
}

function detectIntent(t, metric) {
  if (metric === 'summary') return 'get_summary';
  if (/top|classement|le plus|plus.*abs/.test(t)) return 'top';
  return 'get_metric';
}

// ── SQL Builder ──────────────────────────────────────────────────
function buildSQL(nlp) {
  const { metric, scope_type, scope_value, scope_process, date_mode, date, intent } = nlp;
  let dateExpr;
  if (date_mode === 'specific' && date) dateExpr = `'${date}'::date`;
  else if (date_mode === 'today') dateExpr = 'CURRENT_DATE';
  else if (date_mode === 'yesterday') dateExpr = "CURRENT_DATE - INTERVAL '1 day'";
  else dateExpr = '(SELECT MAX(report_date) FROM daily_hr_report)';

  const col = scope_type === 'group_name' ? 'group_name' : 'plant';
  let filter = `${col} ILIKE '${scope_value.replace(/'/g,"''")}'`;
  if (scope_process) filter += ` AND process ILIKE '${scope_process.replace(/'/g,"''")}'`;

  if (intent === 'get_summary') {
    return `SELECT report_date, ${col} AS scope_label,
      SUM(actif) AS actif, SUM(present) AS present, SUM(nb_abs) AS nb_abs,
      SUM(p) AS p, SUM(np) AS np, SUM(sq) AS sq, SUM(ac) AS ac, SUM(rv) AS rv,
      SUM(ml) AS maladie, SUM(md) AS mise_en_demeure, SUM(total_abs) AS total_abs,
      ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate,
      ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate,
      ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence,
      SUM(retard) AS retard, SUM(heures_sup) AS heures_sup
      FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
      GROUP BY report_date, ${col}`;
  }
  if (intent === 'top') {
    const c = metric === 'maladie' ? 'ml' : metric === 'mise_en_demeure' ? 'md' : metric;
    return `SELECT report_date, ${col} AS scope_label, SUM(${c}) AS value, SUM(actif) AS actif
      FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
      GROUP BY report_date, ${col} ORDER BY value DESC NULLS LAST LIMIT 5`;
  }
  const selectMap = {
    np: 'SUM(np) AS np, SUM(actif) AS actif, ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate',
    p: 'SUM(p) AS p, SUM(actif) AS actif, ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate',
    sq: 'SUM(sq) AS sq', ac: 'SUM(ac) AS ac', rv: 'SUM(rv) AS rv',
    maladie: 'SUM(ml) AS maladie',
    mise_en_demeure: 'SUM(md) AS mise_en_demeure',
    abs_np_rate: 'SUM(np) AS np, SUM(actif) AS actif, ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate',
    abs_p_rate: 'SUM(p) AS p, SUM(actif) AS actif, ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate',
    total_abs: 'SUM(total_abs) AS total_abs, SUM(p) AS p, SUM(np) AS np',
    taux_presence: 'SUM(present) AS present, SUM(actif) AS actif, ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence',
    heures_sup: 'SUM(heures_sup) AS heures_sup',
    heures_presence: 'SUM(heures_presence) AS heures_presence, SUM(actif) AS actif',
    retard: 'SUM(retard) AS retard',
    actif: 'SUM(actif) AS actif',
    present: 'SUM(present) AS present, SUM(actif) AS actif, ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence',
    delta: 'SUM(soll) AS soll, SUM(ist) AS ist, ROUND(SUM(ist)-SUM(soll),2) AS delta',
  };
  const sel = selectMap[metric] || 'SUM(total_abs) AS total_abs, SUM(p) AS p, SUM(np) AS np';
  return `SELECT report_date, ${col} AS scope_label, ${sel}
    FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
    GROUP BY report_date, ${col}`;
}

// ── Formater Réponse ─────────────────────────────────────────────
function fmt(v, dec=1) { return (v==null) ? 'N/D' : Number(v).toFixed(dec); }
function fmtDate(d) {
  if (!d) return 'N/D';
  try { return new Date(d).toLocaleDateString('fr-TN',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  catch(e) { return String(d); }
}

function formatResponse(rows, nlp) {
  const { metric, intent, language: lang, scope_value: scope } = nlp;
  if (!rows || rows.length === 0) {
    const m = { fr:`⚠️ Aucune donnée pour *${scope}*.\n\nVérifiez que le rapport a été importé.`, ar:`⚠️ لا توجد بيانات لـ *${scope}*.`, tn:`⚠️ Makatech data pour *${scope}*.` };
    return m[lang] || m.fr;
  }
  const agg = rows.reduce((a,r) => {
    ['actif','present','nb_abs','p','np','sq','ac','rv','ml','md','maladie','mise_en_demeure','total_abs','retard','heures_sup','soll','ist'].forEach(k => { a[k]=(a[k]||0)+(parseFloat(r[k])||0); });
    a.report_date=r.report_date; return a;
  },{});
  agg.abs_np_rate   = agg.actif ? Math.round(agg.np/agg.actif*10000)/100 : (parseFloat(rows[0]?.abs_np_rate)||0);
  agg.abs_p_rate    = agg.actif ? Math.round(agg.p/agg.actif*10000)/100  : (parseFloat(rows[0]?.abs_p_rate)||0);
  agg.taux_presence = agg.actif ? Math.round(agg.present/agg.actif*10000)/100 : (parseFloat(rows[0]?.taux_presence)||0);
  agg.delta         = rows[0]?.delta!=null ? parseFloat(rows[0].delta)||0 : Math.round((agg.ist-agg.soll)*100)/100;
  agg.maladie=agg.ml; agg.mise_en_demeure=agg.md;
  const dl=fmtDate(agg.report_date), d=agg.delta>=0?'+':'';

  if (intent==='get_summary') {
    const t={
      fr:`📊 *Résumé ${scope}*\n📅 ${dl}\n\n` +
         `👥 Actif : ${fmt(agg.actif,0)} | Présents : ${fmt(agg.present,0)}\n` +
         `✅ Taux Présence : ${fmt(agg.taux_presence)}%\n\n` +
         `❌ NP : ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%)\n` +
         `🗓️ P  : ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n` +
         `📊 Total Abs : ${fmt(agg.total_abs,0)}\n\n` +
         `📋 SQ : ${fmt(agg.sq,0)} | AC : ${fmt(agg.ac,0)} | RV : ${fmt(agg.rv,0)}\n\n` +
         `🏥 ML (Maladie Prolongée) : ${fmt(agg.maladie,0)}\n` +
         `🚪 MD (Mise en demeure / Quittement) : ${fmt(agg.mise_en_demeure,0)}\n` +
         `⚠️ _ML et MD sont deux indicateurs séparés_\n\n` +
         `⏱️ H.Sup : ${fmt(agg.heures_sup,0)} | ⏰ Retard : ${fmt(agg.retard,0)}`,
      ar:`📊 *ملخص ${scope}*\n📅 ${dl}\n\n` +
         `👥 العدد: ${fmt(agg.actif,0)} | الحضور: ${fmt(agg.present,0)} (${fmt(agg.taux_presence)}%)\n` +
         `❌ NP: ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%) | 🗓️ P: ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n` +
         `📊 إجمالي: ${fmt(agg.total_abs,0)}\n` +
         `🏥 ML (مرض طويل الأمد): ${fmt(agg.maladie,0)}\n` +
         `🚪 MD (إنهاء عقد): ${fmt(agg.mise_en_demeure,0)}\n` +
         `⏱️ إضافي: ${fmt(agg.heures_sup,0)} | تأخير: ${fmt(agg.retard,0)}`,
      tn:`📊 *Résumé ${scope}*\n📅 ${dl}\n\n` +
         `👥 ${fmt(agg.actif,0)} | Présents: ${fmt(agg.present,0)} (${fmt(agg.taux_presence)}%)\n` +
         `NP: ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%) | P: ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n` +
         `Total: ${fmt(agg.total_abs,0)}\n` +
         `ML (Maladie Prol.): ${fmt(agg.maladie,0)} | MD (Quittement): ${fmt(agg.mise_en_demeure,0)}\n` +
         `H.Sup: ${fmt(agg.heures_sup,0)} | Retard: ${fmt(agg.retard,0)}`
    };
    return t[lang]||t.fr;
  }
  if (intent==='top') {
    const lines=rows.slice(0,5).map((r,i)=>`  ${i+1}. ${r.scope_label}: ${fmt(r.value||0,0)}`).join('\n');
    return `🏆 *Top 5 — ${metric.toUpperCase()} — ${scope}*\n📅 ${dl}\n\n${lines}`;
  }
  const tpl={
    np:{fr:`📊 *Absence NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)}\n👥 Actif = ${fmt(agg.actif,0)}\n📉 Taux NP = ${fmt(agg.abs_np_rate)}%`,ar:`📊 *غياب NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)} | ${fmt(agg.abs_np_rate)}%`,tn:`📊 *NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%)`},
    p:{fr:`📊 *Absence P — ${scope}*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)}\n👥 Actif = ${fmt(agg.actif,0)}\n📉 Taux P = ${fmt(agg.abs_p_rate)}%`,ar:`📊 *غياب P*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)} | ${fmt(agg.abs_p_rate)}%`,tn:`📊 *P — ${scope}*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)`},
    sq:{fr:`📋 *SQ — ${scope}*\n📅 ${dl}\n\n📋 SQ = ${fmt(agg.sq,0)}`,ar:`📋 *SQ*\n📅 ${dl}\n\nSQ = ${fmt(agg.sq,0)}`,tn:`📋 *SQ*\n📅 ${dl}\n\nSQ = ${fmt(agg.sq,0)}`},
    ac:{fr:`📋 *AC — ${scope}*\n📅 ${dl}\n\n🔁 AC = ${fmt(agg.ac,0)}`,ar:`📋 *AC*\n📅 ${dl}\n\nAC = ${fmt(agg.ac,0)}`,tn:`📋 *AC*\n📅 ${dl}\n\nAC = ${fmt(agg.ac,0)}`},
    rv:{fr:`📋 *RV — ${scope}*\n📅 ${dl}\n\n📌 RV = ${fmt(agg.rv,0)}`,ar:`📋 *RV*\n📅 ${dl}\n\nRV = ${fmt(agg.rv,0)}`,tn:`📋 *RV*\n📅 ${dl}\n\nRV = ${fmt(agg.rv,0)}`},
    maladie:{
      fr:`🏥 *ML — Maladie Prolongée — ${scope}*\n📅 ${dl}\n\n🤒 ML (Maladie Prolongée) = ${fmt(agg.maladie,0)}\n\n⚠️ _ML ≠ MD : ML = maladie prolongée SEULEMENT\nMD = mise en demeure (quittement) — indicateur séparé_`,
      ar:`🏥 *ML — مرض طويل الأمد — ${scope}*\n📅 ${dl}\n\n🤒 ML = ${fmt(agg.maladie,0)}\n_(ML = مرض فقط — MD = إنهاء عقد، مؤشر منفصل)_`,
      tn:`🏥 *ML — Maladie Prolongée — ${scope}*\n📅 ${dl}\n\nML = ${fmt(agg.maladie,0)}\n_(ML ≠ MD: ML = maladie, MD = quittement)_`},
    mise_en_demeure:{
      fr:`⚠️ *MD — Mise en demeure (Quittement) — ${scope}*\n📅 ${dl}\n\n🚪 MD (Mise en demeure / Quittement) = ${fmt(agg.mise_en_demeure,0)}\n\n⚠️ _MD ≠ ML : MD = quittement SEULEMENT\nML = maladie prolongée — indicateur séparé_`,
      ar:`⚠️ *MD — إنهاء عقد / إنذار — ${scope}*\n📅 ${dl}\n\n🚪 MD = ${fmt(agg.mise_en_demeure,0)}\n_(MD = إنهاء عقد فقط — ML = مرض، مؤشر منفصل)_`,
      tn:`⚠️ *MD — Mise en demeure — ${scope}*\n📅 ${dl}\n\nMD = ${fmt(agg.mise_en_demeure,0)}\n_(MD ≠ ML: MD = quittement, ML = maladie)_`},
    abs_np_rate:{fr:`📊 *Taux NP — ${scope}*\n📅 ${dl}\n\n📉 Taux NP = ${fmt(agg.abs_np_rate)}%\n   NP = ${fmt(agg.np,0)} / Actif = ${fmt(agg.actif,0)}`,ar:`📊 *نسبة NP*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_np_rate)}%`,tn:`📊 *Taux NP*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_np_rate)}% (NP=${fmt(agg.np,0)})`},
    abs_p_rate:{fr:`📊 *Taux P — ${scope}*\n📅 ${dl}\n\n📉 Taux P = ${fmt(agg.abs_p_rate)}%\n   P = ${fmt(agg.p,0)} / Actif = ${fmt(agg.actif,0)}`,ar:`📊 *نسبة P*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_p_rate)}%`,tn:`📊 *Taux P*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_p_rate)}%`},
    total_abs:{fr:`📊 *Total Absences — ${scope}*\n📅 ${dl}\n\n👥 Actif : ${fmt(agg.actif,0)}\n❌ NP : ${fmt(agg.np,0)} | 🗓️ P : ${fmt(agg.p,0)}\n📊 Total Abs = ${fmt(agg.total_abs,0)}`,ar:`📊 *إجمالي الغيابات*\n📅 ${dl}\n\nNP=${fmt(agg.np,0)} | P=${fmt(agg.p,0)} | Total=${fmt(agg.total_abs,0)}`,tn:`📊 *Total Abs*\n📅 ${dl}\n\nNP=${fmt(agg.np,0)} | P=${fmt(agg.p,0)} | Total=${fmt(agg.total_abs,0)}`},
    taux_presence:{fr:`✅ *Taux Présence — ${scope}*\n📅 ${dl}\n\n✅ Taux = ${fmt(agg.taux_presence)}%\n   Présents = ${fmt(agg.present,0)} / Actif = ${fmt(agg.actif,0)}`,ar:`✅ *نسبة الحضور*\n📅 ${dl}\n\n✅ ${fmt(agg.taux_presence)}%`,tn:`✅ *Présence*\n📅 ${dl}\n\n✅ ${fmt(agg.taux_presence)}%`},
    delta:{fr:`⚖️ *Delta Soll/IST — ${scope}*\n📅 ${dl}\n\n🎯 Soll = ${fmt(agg.soll,0)}h\n✅ IST = ${fmt(agg.ist,0)}h\n📊 Delta = ${d}${fmt(agg.delta)}h`,ar:`⚖️ *Delta*\n📅 ${dl}\n\nDelta = ${d}${fmt(agg.delta)}h`,tn:`⚖️ *Delta*\n📅 ${dl}\n\n${d}${fmt(agg.delta)}h`},
    heures_sup:{fr:`⏱️ *Heures Sup — ${scope}*\n📅 ${dl}\n\n⏱️ H.Sup = ${fmt(agg.heures_sup,0)}h`,ar:`⏱️ *ساعات إضافية*\n📅 ${dl}\n\n${fmt(agg.heures_sup,0)}h`,tn:`⏱️ *H.Sup*\n📅 ${dl}\n\n${fmt(agg.heures_sup,0)}h`},
    heures_presence:{fr:`🕐 *Heures Présence — ${scope}*\n📅 ${dl}\n\n🕐 H.Présence = ${fmt(parseFloat(rows[0]?.heures_presence)||agg.heures_presence,1)}h\n👥 Actif = ${fmt(agg.actif,0)}`,ar:`🕐 *ساعات الحضور — ${scope}*\n📅 ${dl}\n\n🕐 ${fmt(parseFloat(rows[0]?.heures_presence)||agg.heures_presence,1)}h`,tn:`🕐 *H.Présence*\n📅 ${dl}\n\n🕐 ${fmt(parseFloat(rows[0]?.heures_presence)||agg.heures_presence,1)}h`},
    retard:{fr:`⏰ *Retards — ${scope}*\n📅 ${dl}\n\n⏰ Retards = ${fmt(agg.retard,0)} cas`,ar:`⏰ *تأخيرات*\n📅 ${dl}\n\n${fmt(agg.retard,0)}`,tn:`⏰ *Retards*\n📅 ${dl}\n\n${fmt(agg.retard,0)} cas`},
    actif:{fr:`👥 *Effectif Actif — ${scope}*\n📅 ${dl}\n\n👥 Actif = ${fmt(agg.actif,0)}`,ar:`👥 *العدد*\n📅 ${dl}\n\n👥 ${fmt(agg.actif,0)}`,tn:`👥 *Actif*\n📅 ${dl}\n\n👥 ${fmt(agg.actif,0)}`},
    present:{fr:`✅ *Présents — ${scope}*\n📅 ${dl}\n\n✅ Présents = ${fmt(agg.present,0)} / ${fmt(agg.actif,0)}\n📈 Taux = ${fmt(agg.taux_presence)}%`,ar:`✅ *الحاضرون*\n📅 ${dl}\n\n✅ ${fmt(agg.present,0)}`,tn:`✅ *Présents*\n📅 ${dl}\n\n✅ ${fmt(agg.present,0)} / ${fmt(agg.actif,0)}`},
  };
  const t=tpl[metric]||tpl.total_abs;
  return t[lang]||t.fr;
}

// ── Traitement message ───────────────────────────────────────────
async function processMessage(sock, jid, text) {
  const t = text.toLowerCase().trim();
  const phone = '+' + jid.replace('@s.whatsapp.net','').replace('@c.us','').replace(/\D/g,'');

  console.log(`\n💬 [${phone}] "${text}"`);

  // Vérifier autorisation
  const users = await dbQuery(
    'SELECT * FROM allowed_whatsapp_users WHERE phone_number = $1 AND is_active = TRUE LIMIT 1',
    [phone]
  );

  if (users.length === 0) {
    console.log(`   🚫 Non autorisé: ${phone}`);
    await sock.sendMessage(jid, { text: '🚫 Désolé, votre numéro n\'est pas autorisé.\n\nContactez votre responsable RH.' });
    return;
  }

  const user = users[0];
  console.log(`   ✅ Autorisé: ${user.full_name} (${user.role})`);

  // NLP
  const lang   = detectLang(t);
  const date   = detectDate(t);
  let   metric = detectMetric(t);
  let   scope  = detectScope(t);
  const intent = detectIntent(t, metric);

  // Restriction scope superviseur
  if (user.role === 'supervisor' && user.allowed_scope_type && user.allowed_scope_value) {
    if (scope.type === 'plant') { scope = { type: user.allowed_scope_type, value: user.allowed_scope_value }; }
  }

  const nlp = { metric, intent, language: lang, scope_type: scope.type, scope_value: scope.value, scope_process: scope.process||null, date_mode: date.mode, date: date.date };
  console.log(`   📊 NLP: ${intent} | ${metric} | ${scope.value} | ${date.mode} | ${lang}`);

  // SQL + réponse
  const sql  = buildSQL(nlp);
  const rows = await dbQuery(sql);
  console.log(`   📋 ${rows.length} ligne(s) trouvée(s)`);

  const response = formatResponse(rows, nlp);
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
