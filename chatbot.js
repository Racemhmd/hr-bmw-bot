#!/usr/bin/env node
// ================================================================
// HR BMW U11 — WhatsApp Chatbot (Green API + Neon PostgreSQL)
// Usage: node chatbot.js
// ================================================================

const https = require('https');
const { Client } = require('pg');

// ── Config ───────────────────────────────────────────────────────
const GREEN_ID    = '7107665040';
const GREEN_TOKEN = 'c550d04c1dde4c11af75f8a7fd04a0bb633108512ec34e8bba';
const GREEN_BASE  = `https://7107.api.greenapi.com/waInstance${GREEN_ID}`;
const POLL_MS     = 5000; // Vérifier toutes les 5 secondes

const NEON_URL = process.env.NEON_DATABASE_URL ||
  'postgresql://neondb_owner:npg_8aJpEbywQ6ZT@ep-tiny-glade-at3efk9k-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

// ── Règles métier ────────────────────────────────────────────────
// ML = Maladie SEULEMENT | MD = Mise en demeure SEULEMENT
// Total Abs = P + NP

// ── HTTP helpers ─────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(data ? JSON.parse(data) : null); }
        catch(e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'DELETE' },
      res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

// ── Green API ────────────────────────────────────────────────────
async function receiveNotification() {
  return httpGet(`${GREEN_BASE}/receiveNotification/${GREEN_TOKEN}`);
}

async function deleteNotification(receiptId) {
  return httpDelete(`${GREEN_BASE}/deleteNotification/${GREEN_TOKEN}/${receiptId}`);
}

async function sendMessage(chatId, message) {
  return httpPost(`${GREEN_BASE}/sendMessage/${GREEN_TOKEN}`, { chatId, message });
}

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

// ── Extraction message ───────────────────────────────────────────
function extractMessage(notif) {
  const body = notif.body || {};
  const type = body.typeWebhook || '';
  const isIn  = type === 'incomingMessageReceived';
  const isOut = type === 'outgoingMessageReceived';
  if (!isIn && !isOut) return null;

  const msgData    = body.messageData || {};
  const textMsg    = msgData.textMessageData || msgData.extendedTextMessageData || {};
  const senderData = body.senderData || {};
  const message    = (textMsg.textMessage || textMsg.text || '').trim();
  if (!message) return null;

  const chatId   = senderData.chatId || senderData.sender || '';
  const rawPhone = isIn ? (senderData.sender || '') : (senderData.chatId || '');
  const phone    = '+' + rawPhone.replace('@c.us','').replace(/\D/g,'');

  // Anti-boucle : ignorer les réponses du bot
  const BOT_PFX = ['📊','✅','❌','🤖','📅','⚠️','🏥','🗓️','👥','🎯','⏰','⏱️','⚖️','🏆','🚫'];
  if (isOut && BOT_PFX.some(p => message.startsWith(p))) return null;

  return { phone_number: phone, chat_id: chatId, message_text: message };
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
  if (/aujourd|lyoum|اليوم|today/.test(t)) return { mode: 'today' };
  if (/hier|امس|yesterday/.test(t)) return { mode: 'yesterday' };
  return { mode: 'latest' };
}

function detectMetric(t) {
  if (/taux.*np|pourcentage.*np|taux abs np|abs np rate/.test(t)) return 'abs_np_rate';
  if (/taux.*\bp\b|taux abs p|abs p rate/.test(t)) return 'abs_p_rate';
  if (/taux.*pré|taux.*presence|taux presence/.test(t)) return 'taux_presence';
  if (/\bnp\b|absence np|abs np|non plan/.test(t)) return 'np';
  if (/\bp\b|absence planif|abs p/.test(t) && !/np/.test(t)) return 'p';
  if (/\bsq\b|sans questionnaire/.test(t)) return 'sq';
  if (/\bac\b|absence continue/.test(t)) return 'ac';
  if (/\brv\b|rendez.vous/.test(t)) return 'rv';
  if (/\bml\b|maladie|مرض|maradh/.test(t) && !/mise en demeure|\bmd\b/.test(t)) return 'maladie';
  if (/\bmd\b|mise en demeure/.test(t)) return 'mise_en_demeure';
  if (/\bdelta\b|soll.*ist|ist.*soll|écart/.test(t)) return 'delta';
  if (/h.*sup|heures sup|hsup/.test(t)) return 'heures_sup';
  if (/retard|تأخر/.test(t)) return 'retard';
  if (/actif|effectif/.test(t) && !/absence/.test(t)) return 'actif';
  if (/présent|present|حاضر/.test(t) && !/taux/.test(t)) return 'present';
  if (/résumé|resume|ملخص|tous.*indicateurs|chiffres/.test(t)) return 'summary';
  return 'total_abs';
}

function detectScope(t) {
  const g = t.match(/\b(g[-.]?\d{3,4})\b/i);
  if (g) return { type: 'group_name', value: g[0].replace(/[\s.]/g,'-').toUpperCase() };
  if (/bmw u11|plant|tout le plant/.test(t)) return { type: 'plant', value: 'BMW U11' };
  return { type: 'plant', value: 'BMW U11' };
}

function detectIntent(t, metric) {
  if (metric === 'summary') return 'get_summary';
  if (/plus.*abs|top|classement|le plus/.test(t)) return 'top';
  return 'get_metric';
}

// ── SQL Builder ──────────────────────────────────────────────────
function buildSQL(nlp) {
  const { metric, scope_type, scope_value, date_mode, date, intent } = nlp;

  let dateExpr;
  if (date_mode === 'specific' && date) dateExpr = `'${date}'::date`;
  else if (date_mode === 'today') dateExpr = 'CURRENT_DATE';
  else if (date_mode === 'yesterday') dateExpr = "CURRENT_DATE - INTERVAL '1 day'";
  else dateExpr = '(SELECT MAX(report_date) FROM daily_hr_report)';

  const colMap = { plant:'plant', group_name:'group_name', perimeter:'perimeter', process:'process', circuit:'circuit' };
  const filterCol = colMap[scope_type] || 'plant';
  const filter = `${filterCol} ILIKE '${scope_value.replace(/'/g,"''")}'`;
  const groupCol = filterCol;

  if (intent === 'get_summary') {
    return `SELECT report_date, ${groupCol} AS scope_label,
      SUM(actif) AS actif, SUM(present) AS present, SUM(nb_abs) AS nb_abs,
      SUM(p) AS p, SUM(np) AS np, SUM(sq) AS sq, SUM(ac) AS ac, SUM(rv) AS rv,
      SUM(ml) AS maladie, SUM(md) AS mise_en_demeure, SUM(total_abs) AS total_abs,
      ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate,
      ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate,
      ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence,
      SUM(retard) AS retard, SUM(heures_sup) AS heures_sup,
      SUM(soll) AS soll, SUM(ist) AS ist, ROUND(SUM(ist)-SUM(soll),2) AS delta
      FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
      GROUP BY report_date, ${groupCol}`;
  }

  if (intent === 'top') {
    const col = metric === 'maladie' ? 'ml' : metric === 'mise_en_demeure' ? 'md' : metric;
    return `SELECT report_date, ${groupCol} AS scope_label, SUM(${col}) AS value, SUM(actif) AS actif
      FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
      GROUP BY report_date, ${groupCol} ORDER BY value DESC NULLS LAST LIMIT 5`;
  }

  const selectMap = {
    np:              'SUM(np) AS np, SUM(actif) AS actif, ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate',
    p:               'SUM(p) AS p, SUM(actif) AS actif, ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate',
    sq:              'SUM(sq) AS sq',
    ac:              'SUM(ac) AS ac',
    rv:              'SUM(rv) AS rv',
    maladie:         'SUM(ml) AS maladie',
    mise_en_demeure: 'SUM(md) AS mise_en_demeure',
    abs_np_rate:     'SUM(np) AS np, SUM(actif) AS actif, ROUND(SUM(np)/NULLIF(SUM(actif),0)*100,2) AS abs_np_rate',
    abs_p_rate:      'SUM(p) AS p, SUM(actif) AS actif, ROUND(SUM(p)/NULLIF(SUM(actif),0)*100,2) AS abs_p_rate',
    total_abs:       'SUM(total_abs) AS total_abs, SUM(p) AS p, SUM(np) AS np',
    taux_presence:   'SUM(present) AS present, SUM(actif) AS actif, ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence',
    heures_sup:      'SUM(heures_sup) AS heures_sup',
    retard:          'SUM(retard) AS retard',
    actif:           'SUM(actif) AS actif',
    present:         'SUM(present) AS present, SUM(actif) AS actif, ROUND(SUM(present)/NULLIF(SUM(actif),0)*100,2) AS taux_presence',
    delta:           'SUM(soll) AS soll, SUM(ist) AS ist, ROUND(SUM(ist)-SUM(soll),2) AS delta',
    soll:            'SUM(soll) AS soll, SUM(ist) AS ist',
    ist:             'SUM(ist) AS ist, SUM(soll) AS soll',
  };
  const sel = selectMap[metric] || 'SUM(total_abs) AS total_abs, SUM(p) AS p, SUM(np) AS np';
  return `SELECT report_date, ${groupCol} AS scope_label, ${sel}
    FROM daily_hr_report WHERE report_date = ${dateExpr} AND ${filter}
    GROUP BY report_date, ${groupCol}`;
}

// ── Formater Réponse ─────────────────────────────────────────────
function fmt(v, dec=1) { return (v===null||v===undefined) ? 'N/D' : Number(v).toFixed(dec); }
function fmtDate(d) {
  if (!d) return 'N/D';
  try { return new Date(d).toLocaleDateString('fr-TN',{day:'2-digit',month:'2-digit',year:'numeric'}); }
  catch(e) { return String(d); }
}

function formatResponse(rows, nlp) {
  const { metric, intent, language: lang, scope_value: scope } = nlp;

  if (!rows || rows.length === 0) {
    const msgs = {
      fr: `⚠️ Aucune donnée pour *${scope}*.\n\nVérifiez que le rapport a été importé pour cette date.`,
      ar: `⚠️ لا توجد بيانات لـ *${scope}*.`,
      tn: `⚠️ Makatech data pour *${scope}*. Vérifiez li el rapport importé.`
    };
    return msgs[lang] || msgs.fr;
  }

  const agg = rows.reduce((a, r) => {
    ['actif','present','nb_abs','p','np','sq','ac','rv','ml','md','maladie','mise_en_demeure',
     'total_abs','heures_presence','retard','heures_sup','soll','ist'].forEach(k => {
      a[k] = (a[k]||0) + (parseFloat(r[k])||0);
    });
    a.report_date = r.report_date; a.scope_label = r.scope_label;
    return a;
  }, {});

  agg.abs_np_rate   = agg.actif ? Math.round(agg.np/agg.actif*10000)/100 : (parseFloat(rows[0]?.abs_np_rate)||0);
  agg.abs_p_rate    = agg.actif ? Math.round(agg.p/agg.actif*10000)/100  : (parseFloat(rows[0]?.abs_p_rate)||0);
  agg.taux_presence = agg.actif ? Math.round(agg.present/agg.actif*10000)/100 : (parseFloat(rows[0]?.taux_presence)||0);
  agg.delta         = rows[0]?.delta !== undefined ? parseFloat(rows[0].delta)||0 : Math.round((agg.ist-agg.soll)*100)/100;
  agg.maladie       = agg.ml;
  agg.mise_en_demeure = agg.md;

  const dl = fmtDate(agg.report_date);
  const d = agg.delta >= 0 ? '+' : '';

  if (intent === 'get_summary') {
    const t = {
      fr: `📊 *Résumé ${scope}*\n📅 Date : ${dl}\n\n👥 Actif : ${fmt(agg.actif,0)} | Présents : ${fmt(agg.present,0)}\n❌ NP : ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%)\n🗓️ P : ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n📊 Total Abs : ${fmt(agg.total_abs,0)}\n📋 SQ : ${fmt(agg.sq,0)} | AC : ${fmt(agg.ac,0)} | RV : ${fmt(agg.rv,0)}\n🏥 Maladie ML : ${fmt(agg.maladie,0)}\n⚠️ Mise/dem MD : ${fmt(agg.mise_en_demeure,0)}\n✅ Présence : ${fmt(agg.taux_presence)}%\n⏱️ H.Sup : ${fmt(agg.heures_sup,0)} | Retard : ${fmt(agg.retard,0)}`,
      ar: `📊 *ملخص ${scope}*\n📅 ${dl}\n\n👥 العدد: ${fmt(agg.actif,0)} | الحاضرون: ${fmt(agg.present,0)}\n❌ NP: ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%)\n🗓️ P: ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n📊 الغياب: ${fmt(agg.total_abs,0)}\n🏥 ML: ${fmt(agg.maladie,0)} | ⚠️ MD: ${fmt(agg.mise_en_demeure,0)}\n✅ الحضور: ${fmt(agg.taux_presence)}%`,
      tn: `📊 *Résumé ${scope}*\n📅 ${dl}\n\n👥 Actifs: ${fmt(agg.actif,0)} | Présents: ${fmt(agg.present,0)}\n❌ NP: ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%) | 🗓️ P: ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)\n📊 Total: ${fmt(agg.total_abs,0)} | 🏥 ML: ${fmt(agg.maladie,0)} | ⚠️ MD: ${fmt(agg.mise_en_demeure,0)}\n✅ Présence: ${fmt(agg.taux_presence)}%`
    };
    return t[lang] || t.fr;
  }

  if (intent === 'top') {
    const lines = rows.slice(0,5).map((r,i)=>`  ${i+1}. ${r.scope_label}: ${fmt(r.value||0,0)}`).join('\n');
    return `🏆 *Top 5 — ${metric.toUpperCase()} — ${scope}*\n📅 ${dl}\n\n${lines}`;
  }

  const tpl = {
    np:              { fr:`📊 *Absence NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)}\n👥 Actif = ${fmt(agg.actif,0)}\n📉 Taux NP = ${fmt(agg.abs_np_rate)}%`, ar:`📊 *غياب NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)} | ${fmt(agg.abs_np_rate)}%`, tn:`📊 *NP — ${scope}*\n📅 ${dl}\n\n❌ NP = ${fmt(agg.np,0)} (${fmt(agg.abs_np_rate)}%)` },
    p:               { fr:`📊 *Absence P — ${scope}*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)}\n👥 Actif = ${fmt(agg.actif,0)}\n📉 Taux P = ${fmt(agg.abs_p_rate)}%`, ar:`📊 *غياب P*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)} | ${fmt(agg.abs_p_rate)}%`, tn:`📊 *P — ${scope}*\n📅 ${dl}\n\n🗓️ P = ${fmt(agg.p,0)} (${fmt(agg.abs_p_rate)}%)` },
    sq:              { fr:`📋 *SQ — ${scope}*\n📅 ${dl}\n\n📋 SQ = ${fmt(agg.sq,0)}`, ar:`📋 *SQ*\n📅 ${dl}\n\nSQ = ${fmt(agg.sq,0)}`, tn:`📋 *SQ — ${scope}*\n📅 ${dl}\n\nSQ = ${fmt(agg.sq,0)}` },
    ac:              { fr:`📋 *AC — ${scope}*\n📅 ${dl}\n\n🔁 AC = ${fmt(agg.ac,0)}`, ar:`📋 *AC*\n📅 ${dl}\n\nAC = ${fmt(agg.ac,0)}`, tn:`📋 *AC*\n📅 ${dl}\n\nAC = ${fmt(agg.ac,0)}` },
    rv:              { fr:`📋 *RV — ${scope}*\n📅 ${dl}\n\n📌 RV = ${fmt(agg.rv,0)}`, ar:`📋 *RV*\n📅 ${dl}\n\nRV = ${fmt(agg.rv,0)}`, tn:`📋 *RV*\n📅 ${dl}\n\nRV = ${fmt(agg.rv,0)}` },
    maladie:         { fr:`🏥 *Maladie ML — ${scope}*\n📅 ${dl}\n\n🤒 ML = ${fmt(agg.maladie,0)}\n_(MD = Mise en demeure, indicateur séparé)_`, ar:`🏥 *مرض ML*\n📅 ${dl}\n\nML = ${fmt(agg.maladie,0)}`, tn:`🏥 *ML — ${scope}*\n📅 ${dl}\n\nML = ${fmt(agg.maladie,0)} (ML seulement)` },
    mise_en_demeure: { fr:`⚠️ *Mise en demeure MD — ${scope}*\n📅 ${dl}\n\n⚠️ MD = ${fmt(agg.mise_en_demeure,0)}\n_(ML = Maladie, indicateur séparé)_`, ar:`⚠️ *إنذار MD*\n📅 ${dl}\n\nMD = ${fmt(agg.mise_en_demeure,0)}`, tn:`⚠️ *MD — ${scope}*\n📅 ${dl}\n\nMD = ${fmt(agg.mise_en_demeure,0)}` },
    abs_np_rate:     { fr:`📊 *Taux NP — ${scope}*\n📅 ${dl}\n\n📉 Taux NP = ${fmt(agg.abs_np_rate)}%\n   NP = ${fmt(agg.np,0)} / Actif = ${fmt(agg.actif,0)}`, ar:`📊 *نسبة NP*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_np_rate)}%`, tn:`📊 *Taux NP — ${scope}*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_np_rate)}% (NP=${fmt(agg.np,0)})` },
    abs_p_rate:      { fr:`📊 *Taux P — ${scope}*\n📅 ${dl}\n\n📉 Taux P = ${fmt(agg.abs_p_rate)}%\n   P = ${fmt(agg.p,0)} / Actif = ${fmt(agg.actif,0)}`, ar:`📊 *نسبة P*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_p_rate)}%`, tn:`📊 *Taux P*\n📅 ${dl}\n\n📉 ${fmt(agg.abs_p_rate)}%` },
    total_abs:       { fr:`📊 *Total Absences — ${scope}*\n📅 ${dl}\n\n👥 Actif : ${fmt(agg.actif,0)}\n❌ NP : ${fmt(agg.np,0)} | 🗓️ P : ${fmt(agg.p,0)}\n📊 Total Abs = ${fmt(agg.total_abs,0)}`, ar:`📊 *إجمالي الغيابات*\n📅 ${dl}\n\nNP=${fmt(agg.np,0)} | P=${fmt(agg.p,0)} | Total=${fmt(agg.total_abs,0)}`, tn:`📊 *Total Abs*\n📅 ${dl}\n\nNP=${fmt(agg.np,0)} | P=${fmt(agg.p,0)} | Total=${fmt(agg.total_abs,0)}` },
    taux_presence:   { fr:`✅ *Taux Présence — ${scope}*\n📅 ${dl}\n\n✅ Taux = ${fmt(agg.taux_presence)}%\n   Présents = ${fmt(agg.present,0)} / Actif = ${fmt(agg.actif,0)}`, ar:`✅ *نسبة الحضور*\n📅 ${dl}\n\n✅ ${fmt(agg.taux_presence)}%`, tn:`✅ *Présence*\n📅 ${dl}\n\n✅ ${fmt(agg.taux_presence)}%` },
    delta:           { fr:`⚖️ *Delta Soll/IST — ${scope}*\n📅 ${dl}\n\n🎯 Soll = ${fmt(agg.soll,0)}h\n✅ IST = ${fmt(agg.ist,0)}h\n📊 Delta = ${d}${fmt(agg.delta)}h`, ar:`⚖️ *Delta*\n📅 ${dl}\n\nSoll=${fmt(agg.soll,0)}h | IST=${fmt(agg.ist,0)}h | Delta=${fmt(agg.delta)}h`, tn:`⚖️ *Delta*\n📅 ${dl}\n\n${d}${fmt(agg.delta)}h` },
    heures_sup:      { fr:`⏱️ *Heures Sup — ${scope}*\n📅 ${dl}\n\n⏱️ H.Sup = ${fmt(agg.heures_sup,0)}h`, ar:`⏱️ *ساعات إضافية*\n📅 ${dl}\n\n${fmt(agg.heures_sup,0)}h`, tn:`⏱️ *H.Sup*\n📅 ${dl}\n\n${fmt(agg.heures_sup,0)}h` },
    retard:          { fr:`⏰ *Retards — ${scope}*\n📅 ${dl}\n\n⏰ Retards = ${fmt(agg.retard,0)} cas`, ar:`⏰ *تأخيرات*\n📅 ${dl}\n\n${fmt(agg.retard,0)}`, tn:`⏰ *Retards*\n📅 ${dl}\n\n${fmt(agg.retard,0)} cas` },
    actif:           { fr:`👥 *Effectif Actif — ${scope}*\n📅 ${dl}\n\n👥 Actif = ${fmt(agg.actif,0)}`, ar:`👥 *العدد*\n📅 ${dl}\n\n👥 ${fmt(agg.actif,0)}`, tn:`👥 *Actif*\n📅 ${dl}\n\n👥 ${fmt(agg.actif,0)}` },
    present:         { fr:`✅ *Présents — ${scope}*\n📅 ${dl}\n\n✅ Présents = ${fmt(agg.present,0)} / ${fmt(agg.actif,0)}\n📈 Taux = ${fmt(agg.taux_presence)}%`, ar:`✅ *الحاضرون*\n📅 ${dl}\n\n✅ ${fmt(agg.present,0)} / ${fmt(agg.actif,0)}`, tn:`✅ *Présents*\n📅 ${dl}\n\n✅ ${fmt(agg.present,0)} / ${fmt(agg.actif,0)}` },
  };
  const t = tpl[metric] || tpl.total_abs;
  return t[lang] || t.fr;
}

// ── Traitement message ───────────────────────────────────────────
async function processMessage(msg) {
  const { phone_number, chat_id, message_text } = msg;
  const t = message_text.toLowerCase().trim();

  console.log(`\n💬 [${phone_number}] "${message_text}"`);

  // Vérifier autorisation
  const users = await dbQuery(
    'SELECT phone_number, full_name, role, allowed_scope_type, allowed_scope_value, language_pref FROM allowed_whatsapp_users WHERE phone_number = $1 AND is_active = TRUE LIMIT 1',
    [phone_number]
  );

  if (users.length === 0) {
    console.log(`   🚫 Non autorisé: ${phone_number}`);
    await sendMessage(chat_id,
      '🚫 Désolé, votre numéro n\'est pas autorisé à utiliser HR BMW U11 Chatbot.\n\nContactez votre responsable RH.');
    return;
  }

  const user = users[0];
  console.log(`   ✅ Autorisé: ${user.full_name} (${user.role})`);

  // NLP
  const lang   = detectLang(t);
  const date   = detectDate(t);
  const metric = detectMetric(t);
  const scope  = detectScope(t);
  const intent = detectIntent(t, metric);

  // Appliquer restriction scope superviseur
  if (user.role === 'supervisor' && user.allowed_scope_type && user.allowed_scope_value) {
    if (scope.type === 'plant') { scope.type = user.allowed_scope_type; scope.value = user.allowed_scope_value; }
  }

  const nlp = { metric, intent, language: lang, scope_type: scope.type, scope_value: scope.value, date_mode: date.mode, date: date.date };
  console.log(`   📊 NLP: intent=${intent} metric=${metric} scope=${scope.value} date=${date.mode} lang=${lang}`);

  // SQL
  const sql = buildSQL(nlp);
  console.log(`   🔍 SQL: ${sql.substring(0,80)}...`);

  const rows = await dbQuery(sql);
  console.log(`   📋 Résultats: ${rows.length} lignes`);

  // Formater et envoyer
  const response = formatResponse(rows, nlp);
  console.log(`   📤 Envoi réponse...`);
  await sendMessage(chat_id, response);
  console.log(`   ✅ Réponse envoyée !`);
}

// ── Boucle principale ────────────────────────────────────────────
async function main() {
  console.log('🤖 HR BMW U11 WhatsApp Chatbot démarré');
  console.log(`   Polling toutes les ${POLL_MS/1000}s`);
  console.log('   Appuyez Ctrl+C pour arrêter\n');

  while (true) {
    try {
      const notif = await receiveNotification();

      if (notif && notif.receiptId) {
        const msg = extractMessage(notif);
        if (msg) {
          await processMessage(msg);
        } else {
          console.log(`   ⏭️  Notification ignorée (type: ${notif.body?.typeWebhook})`);
        }
        await deleteNotification(notif.receiptId);
      }
    } catch (err) {
      console.error('❌ Erreur:', err.message);
      // Reconnexion DB si nécessaire
      if (err.message?.includes('connection')) { dbClient = null; }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main();
