#!/usr/bin/env node
// ================================================================
// HR BMW U11 — Upload Rapport Journalier → Neon PostgreSQL
// Usage: node upload_rapport.js "chemin\vers\rapport.html"
// ================================================================

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

// ── Configuration Neon ───────────────────────────────────────────
const NEON_URL = process.env.NEON_DATABASE_URL ||
  'postgresql://neondb_owner:npg_8aJpEbywQ6ZT@ep-tiny-glade-at3efk9k-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

// ── Règle critique ───────────────────────────────────────────────
// maladie = ml SEULEMENT (JAMAIS ml + md)

const MOIS_FR = {
  'janvier':1,'fevrier':2,'février':2,'mars':3,'avril':4,'mai':5,'juin':6,
  'juillet':7,'aout':8,'août':8,'septembre':9,'octobre':10,'novembre':11,
  'decembre':12,'décembre':12
};

function parseJour(jour, year) {
  const j = String(jour||'').trim();
  const m1 = j.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m1) return year+'-'+String(+m1[2]).padStart(2,'0')+'-'+String(+m1[1]).padStart(2,'0');
  const m2 = j.match(/^(\d{1,2})[-\s](.+)$/);
  if (m2) {
    const mNum = MOIS_FR[m2[2].trim().toLowerCase()];
    if (mNum) return year+'-'+String(mNum).padStart(2,'0')+'-'+String(+m2[1]).padStart(2,'0');
  }
  return null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('❌ Usage: node upload_rapport.js "chemin\\vers\\rapport.html"');
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error('❌ Fichier introuvable:', absPath);
    process.exit(1);
  }

  console.log('📂 Lecture du fichier:', absPath);
  const html = fs.readFileSync(absPath, 'utf-8');
  console.log('✓ Fichier lu (' + (html.length/1024/1024).toFixed(1) + ' MB)');

  // ── Extraire initialRecords ──────────────────────────────────
  const MARKER     = 'const initialRecords = ';
  const MARKER_END = ';\nlet currentRecords = [];';
  const si = html.indexOf(MARKER);
  if (si === -1) throw new Error('initialRecords non trouvé dans le HTML.');
  const ei = html.indexOf(MARKER_END, si + MARKER.length);
  if (ei === -1) throw new Error('Fin de initialRecords non trouvée.');

  const rawRecords = JSON.parse(html.substring(si + MARKER.length, ei));
  console.log('✓ Enregistrements bruts:', rawRecords.length, 'lignes');

  // ── Agréger par (date, plant, groupe) ───────────────────────
  const groups = {};
  let skipped = 0;
  for (const r of rawRecords) {
    const ym = String(r.kw_y||'').match(/(\d{4})$/);
    const year = ym ? ym[1] : String(new Date().getFullYear());
    const reportDate = parseJour(r.jour, year);
    if (!reportDate) { skipped++; continue; }
    const plant  = String(r.plant||'BMW U11').trim();
    const groupe = String(r.groupe||'').trim();
    const key    = reportDate+'||'+plant+'||'+groupe;
    if (!groups[key]) groups[key] = {
      report_date:reportDate, plant, group_name:groupe,
      process:String(r.psm||'').trim(),
      circuit:String(r.segment||'').trim(),
      perimeter:plant,
      actif:0,present:0,p:0,np:0,sq:0,ac:0,rv:0,ml:0,
      heures_presence:0,heures_sup:0,retard:0,_rows:0
    };
    const g = groups[key];
    g.actif+=+(r.actif||0); g.present+=+(r.present||0);
    g.p+=+(r.p||0); g.np+=+(r.np||0); g.sq+=+(r.sq||0);
    g.ac+=+(r.ac||0); g.rv+=+(r.rv||0); g.ml+=+(r.ml||0);
    g.heures_presence+=+(r.presence_hours||0);
    g.heures_sup+=+(r.h_sup||0); g.retard+=+(r.retard||0);
    g._rows++;
  }

  const rows = Object.values(groups);
  console.log('✓ Lignes agrégées:', rows.length, '(skipped:', skipped+')');

  // Afficher un résumé
  const dates = [...new Set(rows.map(r=>r.report_date))].sort();
  console.log('📅 Dates:', dates.join(', '));

  // ── Connexion Neon ───────────────────────────────────────────
  console.log('\n🔌 Connexion à Neon PostgreSQL...');
  const client = new Client({ connectionString: NEON_URL });
  await client.connect();
  console.log('✓ Connecté');

  // ── UPSERT ───────────────────────────────────────────────────
  const UPSERT = `
    INSERT INTO daily_hr_report (
      report_date, plant, perimeter, process, circuit, group_name,
      actif, present, nb_abs, p, np, sq, ac, rv, ml, md,
      maladie, mise_en_demeure, abs_p_rate, abs_np_rate, total_abs,
      taux_presence, heures_presence, retard, heures_sup,
      soll, ist, delta, raw_json, source_file, uploaded_by
    ) VALUES (
      $1::date,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
      $17,$18,$19,$20,$21,
      $22,$23,$24,$25,
      $26,$27,$28,$29::jsonb,$30,$31
    )
    ON CONFLICT (report_date, plant, group_name) DO UPDATE SET
      actif=EXCLUDED.actif, present=EXCLUDED.present, nb_abs=EXCLUDED.nb_abs,
      p=EXCLUDED.p, np=EXCLUDED.np, sq=EXCLUDED.sq, ac=EXCLUDED.ac, rv=EXCLUDED.rv,
      ml=EXCLUDED.ml, md=EXCLUDED.md,
      maladie=EXCLUDED.maladie, mise_en_demeure=EXCLUDED.mise_en_demeure,
      abs_p_rate=EXCLUDED.abs_p_rate, abs_np_rate=EXCLUDED.abs_np_rate,
      total_abs=EXCLUDED.total_abs, taux_presence=EXCLUDED.taux_presence,
      heures_presence=EXCLUDED.heures_presence, retard=EXCLUDED.retard,
      heures_sup=EXCLUDED.heures_sup, source_file=EXCLUDED.source_file,
      raw_json=EXCLUDED.raw_json
  `;

  let inserted = 0, updated = 0;
  for (const g of rows) {
    const ml  = g.ml, md = 0;
    const p   = g.p,  np = g.np;
    const actif = g.actif, present = g.present;
    const r2  = v => parseFloat(v.toFixed(2));

    const params = [
      g.report_date, g.plant, g.perimeter, g.process, g.circuit, g.group_name,
      actif, present, actif-present, p, np, g.sq, g.ac, g.rv, ml, md,
      ml,   // maladie = ml SEULEMENT
      md,   // mise_en_demeure = md SEULEMENT
      actif>0?r2(p/actif*100):0,
      actif>0?r2(np/actif*100):0,
      p+np,
      actif>0?r2(present/actif*100):0,
      r2(g.heures_presence), r2(g.retard), r2(g.heures_sup),
      0, 0, 0,
      JSON.stringify({source:'html_script',rows:g._rows}),
      path.basename(absPath),
      'script_local'
    ];

    const res = await client.query(UPSERT, params);
    if (res.rowCount > 0) inserted++;
    else updated++;

    process.stdout.write('\r⏳ Progression: ' + (inserted+updated) + '/' + rows.length);
  }

  // Historique
  await client.query(`
    INSERT INTO import_history (report_date, plant, source_file, uploaded_by, rows_imported, status, parse_source)
    VALUES (CURRENT_DATE, 'BMW U11', $1, 'script_local', $2, 'success', 'html_initialRecords')
  `, [path.basename(absPath), rows.length]);

  await client.end();

  console.log('\n');
  console.log('✅ Import terminé !');
  console.log('   Lignes insérées/mises à jour:', rows.length);
  console.log('   Dates importées:', dates.join(', '));
  console.log('   💬 Le chatbot WhatsApp est maintenant mis à jour.');
}

main().catch(err => {
  console.error('\n❌ Erreur:', err.message);
  process.exit(1);
});
