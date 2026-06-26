#!/usr/bin/env node
// ================================================================
// HR BMW U11 — Interface Web Upload Rapport
// Usage: node web_upload.js
// Accessible sur: http://localhost:3000 (ou via Cloudflare tunnel)
// ================================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const PORT = 3000;
const NEON_URL = process.env.NEON_DATABASE_URL ||
  'postgresql://neondb_owner:npg_8aJpEbywQ6ZT@ep-tiny-glade-at3efk9k-pooler.c-9.us-east-1.aws.neon.tech/neondb?sslmode=require';

const MOIS_FR = {
  'janvier':1,'fevrier':2,'février':2,'mars':3,'avril':4,'mai':5,'juin':6,
  'juillet':7,'aout':8,'août':8,'septembre':9,'octobre':10,'novembre':11,'decembre':12,'décembre':12
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

async function importHTML(htmlContent, filename) {
  const MARKER     = 'const initialRecords = ';
  const MARKER_END = ';\nlet currentRecords = [];';
  const si = htmlContent.indexOf(MARKER);
  if (si === -1) throw new Error('initialRecords non trouvé dans le HTML.');
  const ei = htmlContent.indexOf(MARKER_END, si + MARKER.length);
  if (ei === -1) throw new Error('Fin de initialRecords non trouvée.');

  const rawRecords = JSON.parse(htmlContent.substring(si + MARKER.length, ei));

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
      process:String(r.psm||'').trim(), circuit:String(r.segment||'').trim(), perimeter:plant,
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
  const dates = [...new Set(rows.map(r=>r.report_date))].sort();

  const client = new Client({ connectionString: NEON_URL });
  await client.connect();

  const UPSERT = `INSERT INTO daily_hr_report (
    report_date,plant,perimeter,process,circuit,group_name,
    actif,present,nb_abs,p,np,sq,ac,rv,ml,md,
    maladie,mise_en_demeure,abs_p_rate,abs_np_rate,total_abs,
    taux_presence,heures_presence,retard,heures_sup,
    soll,ist,delta,raw_json,source_file,uploaded_by
  ) VALUES ($1::date,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31)
  ON CONFLICT (report_date,plant,group_name) DO UPDATE SET
    actif=EXCLUDED.actif,present=EXCLUDED.present,nb_abs=EXCLUDED.nb_abs,
    p=EXCLUDED.p,np=EXCLUDED.np,sq=EXCLUDED.sq,ac=EXCLUDED.ac,rv=EXCLUDED.rv,
    ml=EXCLUDED.ml,md=EXCLUDED.md,maladie=EXCLUDED.maladie,mise_en_demeure=EXCLUDED.mise_en_demeure,
    abs_p_rate=EXCLUDED.abs_p_rate,abs_np_rate=EXCLUDED.abs_np_rate,
    total_abs=EXCLUDED.total_abs,taux_presence=EXCLUDED.taux_presence,
    heures_presence=EXCLUDED.heures_presence,retard=EXCLUDED.retard,
    heures_sup=EXCLUDED.heures_sup,source_file=EXCLUDED.source_file,raw_json=EXCLUDED.raw_json`;

  let count = 0;
  for (const g of rows) {
    const ml=g.ml, md=0, p=g.p, np=g.np, actif=g.actif, present=g.present;
    const r2 = v => parseFloat(v.toFixed(2));
    await client.query(UPSERT, [
      g.report_date,g.plant,g.perimeter,g.process,g.circuit,g.group_name,
      actif,present,actif-present,p,np,g.sq,g.ac,g.rv,ml,md,
      ml,md,
      actif>0?r2(p/actif*100):0,
      actif>0?r2(np/actif*100):0,
      p+np,
      actif>0?r2(present/actif*100):0,
      r2(g.heures_presence),r2(g.retard),r2(g.heures_sup),
      0,0,0,
      JSON.stringify({source:'web_upload',rows:g._rows}),
      filename,'web_upload'
    ]);
    count++;
  }

  await client.query(`INSERT INTO import_history (report_date,plant,source_file,uploaded_by,rows_imported,status,parse_source)
    VALUES (CURRENT_DATE,'BMW U11',$1,'web_upload',$2,'success','html_initialRecords')`,
    [filename, count]);

  await client.end();
  return { rows: count, skipped, dates, rawRecords: rawRecords.length };
}

// ── Serveur HTTP ─────────────────────────────────────────────────
function parseMultipart(body, boundary) {
  const parts = body.split('--' + boundary);
  for (const part of parts) {
    if (part.includes('filename=')) {
      const nameMatch = part.match(/filename="([^"]+)"/);
      const filename  = nameMatch ? nameMatch[1] : 'rapport.html';
      const content   = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n--$/, '').replace(/\r\n$/, '');
      return { filename, content };
    }
  }
  return null;
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HR BMW U11 — Upload Rapport</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: white; border-radius: 12px; padding: 40px; width: 480px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
  .logo { text-align: center; margin-bottom: 24px; }
  .logo h1 { font-size: 22px; color: #1d2b3a; }
  .logo p  { color: #888; font-size: 13px; margin-top: 4px; }
  .drop-zone { border: 2px dashed #0070f3; border-radius: 8px; padding: 40px 20px; text-align: center; cursor: pointer; transition: background 0.2s; }
  .drop-zone:hover, .drop-zone.drag { background: #e8f0fe; }
  .drop-zone input { display: none; }
  .drop-zone .icon { font-size: 48px; }
  .drop-zone p { color: #555; margin-top: 12px; }
  .drop-zone span { color: #0070f3; font-weight: bold; }
  .file-name { margin-top: 12px; padding: 10px; background: #f8f9fa; border-radius: 6px; font-size: 13px; color: #333; display: none; }
  .btn { width: 100%; padding: 14px; background: #0070f3; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 20px; transition: background 0.2s; }
  .btn:hover { background: #0060d3; }
  .btn:disabled { background: #aaa; cursor: not-allowed; }
  .result { margin-top: 20px; padding: 16px; border-radius: 8px; font-size: 14px; display: none; }
  .result.success { background: #e6f4ea; color: #1e7e34; border: 1px solid #c3e6cb; }
  .result.error   { background: #fce8e6; color: #c62828; border: 1px solid #f5c6cb; }
  .progress { margin-top: 16px; display: none; }
  .progress-bar { height: 6px; background: #e0e0e0; border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: #0070f3; width: 0%; transition: width 0.3s; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>🏭 HR BMW U11</h1>
    <p>Upload Rapport Journalier → WhatsApp Chatbot</p>
  </div>
  <form id="uploadForm">
    <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
      <div class="icon">📊</div>
      <p>Glissez votre fichier HTML ici<br>ou <span>cliquez pour choisir</span></p>
      <input type="file" id="fileInput" accept=".html,.htm">
    </div>
    <div class="file-name" id="fileName"></div>
    <div class="progress" id="progress">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <p style="text-align:center;margin-top:8px;color:#555;font-size:13px">Import en cours...</p>
    </div>
    <button type="submit" class="btn" id="submitBtn" disabled>📤 Importer le rapport</button>
    <div class="result" id="result"></div>
  </form>
</div>
<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileName  = document.getElementById('fileName');
const submitBtn = document.getElementById('submitBtn');
const result    = document.getElementById('result');
const progress  = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');

function setFile(file) {
  if (!file) return;
  fileName.style.display = 'block';
  fileName.textContent = '📄 ' + file.name + ' (' + (file.size/1024).toFixed(0) + ' KB)';
  submitBtn.disabled = false;
}

fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file) { fileInput.files = e.dataTransfer.files; setFile(file); }
});

document.getElementById('uploadForm').addEventListener('submit', async e => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  submitBtn.disabled = true;
  progress.style.display = 'block';
  result.style.display = 'none';
  progressFill.style.width = '30%';

  const formData = new FormData();
  formData.append('file', file);

  try {
    progressFill.style.width = '60%';
    const res = await fetch('/upload', { method: 'POST', body: formData });
    progressFill.style.width = '100%';
    const data = await res.json();

    progress.style.display = 'none';
    result.style.display = 'block';

    if (data.ok) {
      result.className = 'result success';
      result.innerHTML = '✅ <strong>Import réussi !</strong><br><br>' +
        '📋 Lignes importées : <strong>' + data.rows + '</strong><br>' +
        '📅 Dates : <strong>' + data.dates.join(', ') + '</strong><br>' +
        '📊 Enregistrements bruts : ' + data.rawRecords + '<br>' +
        '💬 Le chatbot WhatsApp est à jour.';
    } else {
      result.className = 'result error';
      result.innerHTML = '❌ <strong>Erreur :</strong> ' + data.error;
    }
  } catch(err) {
    progress.style.display = 'none';
    result.style.display = 'block';
    result.className = 'result error';
    result.innerHTML = '❌ Erreur réseau : ' + err.message;
  }
  submitBtn.disabled = false;
});
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  if (req.method === 'POST' && req.url === '/upload') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Mauvais format' })); return;
    }
    const boundary = boundaryMatch[1];
    let body = '';
    req.setEncoding('latin1');
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const file = parseMultipart(body, boundary);
        if (!file) throw new Error('Fichier non trouvé dans la requête');

        console.log(`\n📤 Upload reçu: ${file.filename} (${(file.content.length/1024/1024).toFixed(1)} MB)`);
        const result = await importHTML(file.content, file.filename);
        console.log(`✅ Import OK: ${result.rows} lignes | Dates: ${result.dates.join(', ')}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch(err) {
        console.error('❌ Erreur upload:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🌐 Interface Upload HR BMW U11`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Depuis autre PC: exposez via Cloudflare ou réseau local`);
  console.log(`   Appuyez Ctrl+C pour arrêter\n`);
});
