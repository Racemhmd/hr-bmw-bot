// ================================================================
// HR BMW U11 — Parseur de fichiers HTML / Excel / CSV
// Utilisé à la fois comme module Node.js standalone
// et copié dans les Code nodes n8n
// ================================================================

// ─── Mapping complet des colonnes (80+ variantes) ─────────────────────────
const COLUMN_MAP = {
  // Dates
  'date': 'report_date', 'date du rapport': 'report_date',
  'date rapport': 'report_date', 'jour': 'report_date',

  // Plant
  'plant': 'plant', 'usine': 'plant', 'site': 'plant',

  // Périmètre
  'perimetre': 'perimeter', 'perimeter': 'perimeter',
  'périmètre': 'perimeter', 'per.': 'perimeter', 'per': 'perimeter',

  // Process
  'process': 'process', 'processus': 'process', 'proc': 'process', 'proc.': 'process',

  // Circuit
  'circuit': 'circuit', 'circ': 'circuit', 'circ.': 'circuit',

  // Groupe
  'groupe': 'group_name', 'group': 'group_name', 'grp': 'group_name',
  'grp.': 'group_name', 'group name': 'group_name',

  // Area
  'area': 'area', 'zone': 'area', 'secteur': 'area',

  // Effectifs
  'actif': 'actif', 'actif hc': 'actif', 'active': 'actif', 'active hc': 'actif',
  'effectif actif': 'actif', 'hc actif': 'actif', 'hc': 'actif',
  'headcount': 'actif', 'total actif': 'actif',

  'present': 'present', 'presents': 'present', 'présent': 'present',
  'présents': 'present', 'nb présents': 'present', 'nb presents': 'present',

  'nb abs': 'nb_abs', 'nb_abs': 'nb_abs', 'nombre absence': 'nb_abs',
  'nombre absences': 'nb_abs', 'absences': 'nb_abs',

  // Absence planifiée
  'p': 'p', 'abs p': 'p', 'abs planifiee': 'p', 'planifiee': 'p',
  'absence planifiee': 'p', 'absences planifiees': 'p', 'planned': 'p',

  // Absence non planifiée
  'np': 'np', 'abs np': 'np', 'abs non planifiee': 'np',
  'non planifiee': 'np', 'absence non planifiee': 'np', 'unplanned': 'np',

  // SQ — Sans Questionnaire (INDÉPENDANT)
  'sq': 'sq', 'sans questionnaire': 'sq', 'sans quest.': 'sq', 's.q.': 'sq',

  // AC — Absence Continue (INDÉPENDANT)
  'ac': 'ac', 'absence continue': 'ac', 'abs continue': 'ac', 'a.c.': 'ac',

  // RV — Rendez-Vous (INDÉPENDANT)
  'rv': 'rv', 'rendez-vous': 'rv', 'rdv': 'rv', 'r.v.': 'rv',

  // ⚠️ RÈGLE CRITIQUE — ML et MD sont DEUX colonnes SÉPARÉES
  // ML = Maladie SEULEMENT (jamais ML+MD)
  'ml': 'ml', 'maladie': 'ml', 'm.l.': 'ml',

  // MD = Mise en demeure SEULEMENT (jamais MD = maladie)
  'md': 'md', 'mise en demeure': 'md', 'mise-en-demeure': 'md', 'm.d.': 'md',

  // Taux
  '%abs p': 'abs_p_rate', 'taux abs p': 'abs_p_rate', 'abs_p_rate': 'abs_p_rate',
  '%abs planifiee': 'abs_p_rate',

  '%abs np': 'abs_np_rate', 'taux abs np': 'abs_np_rate', 'abs_np_rate': 'abs_np_rate',
  '%abs non planifiee': 'abs_np_rate',

  'total abs': 'total_abs', 'total absence': 'total_abs',
  'total absences': 'total_abs', 'total_abs': 'total_abs',

  'taux presence': 'taux_presence', 'taux présence': 'taux_presence',
  '% presence': 'taux_presence', '% présence': 'taux_presence',
  'taux_presence': 'taux_presence',

  // Heures
  'heures de presences': 'heures_presence', 'heures presence': 'heures_presence',
  'heures_presence': 'heures_presence', 'h presence': 'heures_presence',

  'retard': 'retard', 'retards': 'retard',

  'h sup': 'heures_sup', 'heures sup': 'heures_sup',
  'heures supplementaires': 'heures_sup', 'heures_sup': 'heures_sup', 'hsup': 'heures_sup',

  // Production
  'soll': 'soll', 'sollicitees': 'soll', 'heures soll': 'soll',
  'ist': 'ist', 'actuel': 'ist', 'reel': 'ist', 'heures ist': 'ist',
  'delta': 'delta', 'ecart': 'delta',
};

const NUMERIC_COLS = new Set([
  'actif','present','nb_abs','p','np','sq','ac','rv','ml','md',
  'abs_p_rate','abs_np_rate','total_abs','taux_presence','heures_presence',
  'retard','heures_sup','soll','ist','delta'
]);

// ─── Normaliser clé de colonne ─────────────────────────────────────────────
function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/[éèêë]/g, 'e').replace(/[àâä]/g, 'a')
    .replace(/[ùûü]/g, 'u').replace(/[îï]/g, 'i')
    .replace(/[ôö]/g, 'o').replace(/ç/g, 'c')
    .trim()
    .replace(/\s+/g, ' ');
}

// ─── Convertir en nombre ───────────────────────────────────────────────────
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ─── Parser HTML ───────────────────────────────────────────────────────────
function parseHTML(htmlContent) {
  // Essayer les variables JS en premier
  const JS_VARS = [
    'embeddedRecords','records','currentRecords','initialRecords',
    'savedDays','dailyRecords','tableData','reportData','DATA',
    'rowData','gridData','dataSource','reportRows'
  ];

  for (const varName of JS_VARS) {
    const patterns = [
      new RegExp(`(?:var|const|let)\\s+${varName}\\s*=\\s*(\\[\\s*\\{[\\s\\S]*?\\}\\s*\\])\\s*[;,]`, 'i'),
      new RegExp(`window\\.${varName}\\s*=\\s*(\\[\\s*\\{[\\s\\S]*?\\}\\s*\\])\\s*[;,]`, 'i'),
    ];
    for (const pat of patterns) {
      const m = htmlContent.match(pat);
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          if (Array.isArray(data) && data.length > 0) {
            return { rows: data, source: `js_var:${varName}` };
          }
        } catch(e) {}
      }
    }
  }

  // Fallback : parser le plus grand tableau HTML
  function stripTags(s) { return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').trim(); }

  const tableMatches = [...htmlContent.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  let bestRows = null;
  let bestCount = 0;

  for (const tMatch of tableMatches) {
    const rowMatches = [...tMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rowMatches.length > bestCount) {
      bestCount = rowMatches.length;
      bestRows = rowMatches;
    }
  }

  if (bestRows && bestRows.length > 1) {
    const headers = [...bestRows[0][0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => stripTags(m[1]));
    const rows = [];
    for (let i = 1; i < bestRows.length; i++) {
      const cells = [...bestRows[i][0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(m => stripTags(m[1]));
      if (cells.some(c => c !== '')) {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ''; });
        rows.push(obj);
      }
    }
    if (rows.length > 0) return { rows, source: 'html_table' };
  }

  throw new Error('Aucune donnée trouvée dans le HTML. Vérifiez le format.');
}

// ─── Parser CSV ─────────────────────────────────────────────────────────────
function parseCSV(csvContent) {
  function detectDelimiter(sample) {
    const counts = {';':(sample.match(/;/g)||[]).length, ',':(sample.match(/,/g)||[]).length,
      '\t':(sample.match(/\t/g)||[]).length, '|':(sample.match(/\|/g)||[]).length};
    return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
  }

  function parseLine(line, delim) {
    const result = []; let cur = ''; let inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === delim && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  const lines = csvContent.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim());
  if (lines.length < 2) throw new Error('CSV vide ou sans données');

  const delim = detectDelimiter(lines.slice(0,5).join('\n'));
  const headers = parseLine(lines[0], delim);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i], delim);
    if (cells.every(c=>c==='')) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? ''; });
    rows.push(obj);
  }
  return { rows, source: `csv_delim:${delim==='\t'?'tab':delim}` };
}

// ─── Parser Excel (rows déjà extraites par n8n Spreadsheet node) ──────────
function parseExcelRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Fichier Excel vide');
  return { rows, source: 'excel' };
}

// ─── Calculer les KPIs (règles métier) ─────────────────────────────────────
function calculateKPIs(row) {
  const actif = toNum(row.actif);
  const p = toNum(row.p);
  const np = toNum(row.np);
  const ml = toNum(row.ml);
  const md = toNum(row.md);

  // ⚠️ RÈGLE CRITIQUE : maladie = ML seulement (JAMAIS ml + md)
  row.maladie = ml;
  row.mise_en_demeure = md;

  // Dérivés (seulement si non déjà présents)
  if (!row.total_abs)    row.total_abs = p + np;
  if (!row.abs_p_rate && actif > 0)
    row.abs_p_rate = Math.round(p / actif * 10000) / 100;
  if (!row.abs_np_rate && actif > 0)
    row.abs_np_rate = Math.round(np / actif * 10000) / 100;
  if (!row.taux_presence && actif > 0)
    row.taux_presence = Math.round(toNum(row.present) / actif * 10000) / 100;
  if (!row.delta)
    row.delta = toNum(row.ist) - toNum(row.soll);

  return row;
}

// ─── Normaliser un objet brut → colonnes standard ─────────────────────────
function normalizeRow(rawRow, meta = {}) {
  const normalized = {};

  for (const [key, val] of Object.entries(rawRow)) {
    const nKey = normalizeKey(key);
    const mappedCol = COLUMN_MAP[nKey];
    if (mappedCol) {
      normalized[mappedCol] = val;
    }
  }

  // Convertir numériques
  for (const col of NUMERIC_COLS) {
    normalized[col] = toNum(normalized[col]);
  }

  // Appliquer règles métier
  calculateKPIs(normalized);

  // Métadonnées
  if (meta.report_date) normalized.report_date = meta.report_date;
  if (meta.plant)       normalized.plant = meta.plant;
  if (meta.uploaded_by) normalized.uploaded_by = meta.uploaded_by;
  if (meta.source_file) normalized.source_file = meta.source_file;
  normalized.raw_json = JSON.stringify(rawRow);

  return normalized;
}

// ─── Détecter colonnes présentes / manquantes ─────────────────────────────
function detectColumns(normalizedRows) {
  const RECOMMENDED = ['actif','present','np','p','ml','md','group_name','process'];
  if (!normalizedRows.length) return { detected: [], missing: RECOMMENDED };
  const sample = normalizedRows[0];
  const detected = Object.keys(sample).filter(k => RECOMMENDED.includes(k));
  const missing = RECOMMENDED.filter(k => !detected.includes(k));
  return { detected, missing };
}

module.exports = { parseHTML, parseCSV, parseExcelRows, normalizeRow, detectColumns, COLUMN_MAP, NUMERIC_COLS };
