/**
 * WE SUPPLY THREADS — COMBINED P&L + GA + DASHBOARD
 * Lives in: "Profit Combined" spreadsheet.
 *
 * Tabs it manages:
 *   brands         — registry: brand_name | spreadsheet_id | color | active
 *   combined_flat  — long-format P&L fact table (every brand's daily_pnl stacked)
 *   combined_daily — portfolio P&L rollup, one row per date
 *   ga_flat        — long-format GA fact table (every brand's GA daily tab stacked)
 *
 * Web app:
 *   doGet() serves the responsive dashboard (phone / desktop / TV via ?mode=tv).
 *   The page pulls data with google.script.run.getDashboardData() and auto-refreshes.
 *
 * Also read by Backstage (Profit tab), which matches combined_flat columns by header name.
 *
 * SETUP (one time):
 *   1. Paste Code.gs + index.html into the Apps Script project bound to "Profit Combined".
 *   2. Run setupCombinedBook() once. Authorize.
 *   3. In the `brands` tab, paste each brand's spreadsheet ID (Elder Emo, PopPunks, Wallspoke).
 *   4. Run rebuildCombined() once; verify combined_flat AND ga_flat fill.
 *      Check the execution log — it reports which GA tab it found per brand.
 *   5. Run createHourlyTrigger() once (replaces the old 7am daily trigger).
 *   6. Deploy → Web app → Execute as Me / Only myself. The /exec URL is the dashboard.
 *
 * CHANGELOG
 *   2026-10: added printful_cost and google_spend (Wallspoke fulfils on Printful, and
 *            Google Ads now runs on any brand). They are appended AFTER profit on
 *            purpose: getDashboardData() reads combined_flat by column position, so
 *            inserting them earlier would shift every existing number. A brand sheet
 *            without these columns yet simply contributes 0.
 *            Later: gelato_cost appended too (Elder Emo only). It was always inside
 *            EE's profit but never carried here, so any cost breakdown built on
 *            combined_flat had an unexplained gap.
 *            Rebuild moved from daily (7am) to hourly, so "today" is current in the
 *            dashboard and in Backstage instead of frozen at 7am.
 */

const COMBINED_ID = '1GSm5YA2kCWW61QqxNzZ-lQqS5_ei8LjN53Dyq5zawmE';

// daily_pnl schema shared by every brand sheet (matched by header name).
// New columns go at the END only — see CHANGELOG.
const SCHEMA = [
  'date', 'shopify_revenue', 'shopify_refunds', 'shopify_net', 'shopify_orders',
  'printify_cost', 'meta_spend', 'shopify_fees_est', 'profit',
  'printful_cost', 'google_spend', 'gelato_cost'
];

// GA tab name candidates, tried in order per brand sheet
const GA_TAB_CANDIDATES = ['ga_daily', 'ga4_daily', 'ga', 'ga_pnl'];

// GA columns matched by header alias (lowercased, underscores/spaces stripped)
const GA_FIELDS = [
  { key: 'sessions',  aliases: ['sessions', 'gasessions'] },
  { key: 'users',     aliases: ['users', 'totalusers', 'activeusers'] },
  { key: 'atc',       aliases: ['addtocarts', 'addtocart', 'atc'] },
  { key: 'checkouts', aliases: ['checkouts', 'begincheckout', 'begincheckouts', 'checkout'] },
  { key: 'purchases', aliases: ['purchases', 'transactions', 'ecommercepurchases'] },
  { key: 'revenue',   aliases: ['revenue', 'purchaserevenue', 'garevenue', 'totalrevenue'] }
];

const TAB_BRANDS = 'brands';
const TAB_FLAT   = 'combined_flat';
const TAB_DAILY  = 'combined_daily';
const TAB_GA     = 'ga_flat';
const TZ = Session.getScriptTimeZone();

/* ───────────────────────────── setup ───────────────────────────── */

function setupCombinedBook() {
  const ss = SpreadsheetApp.openById(COMBINED_ID);

  let brands = ss.getSheetByName(TAB_BRANDS);
  if (!brands) {
    brands = ss.insertSheet(TAB_BRANDS);
    brands.getRange(1, 1, 1, 4).setValues([['brand_name', 'spreadsheet_id', 'color', 'active']]);
    brands.getRange(2, 1, 3, 4).setValues([
      ['Elder Emo', 'PASTE_ELDER_EMO_SPREADSHEET_ID', '#D9201F', true],
      ['PopPunks',  '1kuKTWTsHgSEaZjbt-EWhCOBLU-UAV1TQuASeDU6Vhi0', '#FFC629', true],
      ['Wallspoke', '1quc_JWpsG852QWX91Uk5K6RqvirZX8n5Pt-vJI5oaaI', '#1D5FD6', true]
    ]);
    brands.setFrozenRows(1);
  }

  [TAB_FLAT, TAB_DAILY, TAB_GA].forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });

  Logger.log('Setup complete. Confirm brand IDs in the brands tab, then run rebuildCombined().');
}

/* ─────────────────────────── registry ──────────────────────────── */

function getRegistry_() {
  const sheet = SpreadsheetApp.openById(COMBINED_ID).getSheetByName(TAB_BRANDS);
  if (!sheet) throw new Error('brands tab missing — run setupCombinedBook() first.');

  const values = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const [name, id, color, active] = values[i];
    if (!name || !id) continue;
    if (String(id).indexOf('PASTE_') === 0) continue;
    if (active === false || String(active).toLowerCase() === 'false') continue;
    out.push({ name: String(name).trim(), id: String(id).trim(), color: String(color || '#888888').trim() });
  }
  if (!out.length) throw new Error('No active brands with spreadsheet IDs in the brands tab.');
  return out;
}

/* ─────────────────────────── helpers ───────────────────────────── */

function toDateStr_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normHeader_(h) {
  return String(h).trim().toLowerCase().replace(/[\s_]/g, '');
}

/* ─────────────────────────── rebuild ───────────────────────────── */

function rebuildCombined() {
  const ss = SpreadsheetApp.openById(COMBINED_ID);
  const registry = getRegistry_();
  const pnlRows = [];
  const gaRows = [];

  registry.forEach(brand => {
    let book;
    try {
      book = SpreadsheetApp.openById(brand.id);
    } catch (e) {
      Logger.log('SKIP ' + brand.name + ' — cannot open spreadsheet: ' + e.message);
      return;
    }
    collectPnl_(book, brand, pnlRows);
    collectGa_(book, brand, gaRows);
  });

  /* ---- combined_flat ---- */
  pnlRows.sort((a, b) => a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : (a[1] < b[1] ? -1 : 1));
  const flatHeader = ['brand'].concat(SCHEMA);
  const flat = ss.getSheetByName(TAB_FLAT) || ss.insertSheet(TAB_FLAT);
  flat.clearContents();
  flat.getRange(1, 1, 1, flatHeader.length).setValues([flatHeader]);
  if (pnlRows.length) flat.getRange(2, 1, pnlRows.length, flatHeader.length).setValues(pnlRows);
  flat.setFrozenRows(1);

  /* ---- combined_daily ---- */
  const byDate = {};
  pnlRows.forEach(row => {
    const date = row[1];
    if (!byDate[date]) byDate[date] = new Array(SCHEMA.length - 1).fill(0);
    for (let c = 2; c < row.length; c++) byDate[date][c - 2] += row[c];
  });
  const dailyRows = Object.keys(byDate).sort().map(d => [d].concat(byDate[d].map(v => Math.round(v * 100) / 100)));
  const daily = ss.getSheetByName(TAB_DAILY) || ss.insertSheet(TAB_DAILY);
  daily.clearContents();
  daily.getRange(1, 1, 1, SCHEMA.length).setValues([SCHEMA]);
  if (dailyRows.length) daily.getRange(2, 1, dailyRows.length, SCHEMA.length).setValues(dailyRows);
  daily.setFrozenRows(1);

  /* ---- ga_flat ---- */
  gaRows.sort((a, b) => a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : (a[1] < b[1] ? -1 : 1));
  const gaHeader = ['brand', 'date'].concat(GA_FIELDS.map(f => f.key));
  const ga = ss.getSheetByName(TAB_GA) || ss.insertSheet(TAB_GA);
  ga.clearContents();
  ga.getRange(1, 1, 1, gaHeader.length).setValues([gaHeader]);
  if (gaRows.length) ga.getRange(2, 1, gaRows.length, gaHeader.length).setValues(gaRows);
  ga.setFrozenRows(1);

  Logger.log('Rebuilt: ' + pnlRows.length + ' P&L rows, ' + gaRows.length + ' GA rows.');
}

function collectPnl_(book, brand, out) {
  const pnl = book.getSheetByName('daily_pnl');
  if (!pnl) { Logger.log('SKIP ' + brand.name + ' P&L — no daily_pnl tab.'); return; }

  const values = pnl.getDataRange().getValues();
  if (values.length < 2) return;

  const header = values[0].map(h => String(h).trim().toLowerCase());
  const idx = {};
  SCHEMA.forEach(col => { idx[col] = header.indexOf(col); });
  if (idx.date === -1) { Logger.log('SKIP ' + brand.name + ' P&L — daily_pnl has no date column.'); return; }

  const absent = SCHEMA.filter(col => idx[col] === -1);
  if (absent.length) Logger.log(brand.name + ' P&L — no column for: ' + absent.join(', ') + ' (written as 0)');

  for (let r = 1; r < values.length; r++) {
    const raw = values[r];
    const dateStr = toDateStr_(raw[idx.date]);
    if (!dateStr) continue;
    const row = [brand.name, dateStr];
    for (let c = 1; c < SCHEMA.length; c++) {
      const pos = idx[SCHEMA[c]];
      row.push(pos === -1 ? 0 : Number(raw[pos]) || 0);
    }
    out.push(row);
  }
}

function collectGa_(book, brand, out) {
  let gaSheet = null, tabName = '';
  for (let i = 0; i < GA_TAB_CANDIDATES.length; i++) {
    const s = book.getSheetByName(GA_TAB_CANDIDATES[i]);
    if (s) { gaSheet = s; tabName = GA_TAB_CANDIDATES[i]; break; }
  }
  if (!gaSheet) {
    Logger.log('SKIP ' + brand.name + ' GA — no tab named any of: ' + GA_TAB_CANDIDATES.join(', '));
    return;
  }

  const values = gaSheet.getDataRange().getValues();
  if (values.length < 2) return;

  const header = values[0].map(normHeader_);
  const dateIdx = header.indexOf('date');
  if (dateIdx === -1) { Logger.log('SKIP ' + brand.name + ' GA — "' + tabName + '" has no date column.'); return; }

  const fieldIdx = GA_FIELDS.map(f => {
    for (let a = 0; a < f.aliases.length; a++) {
      const pos = header.indexOf(f.aliases[a]);
      if (pos !== -1) return pos;
    }
    return -1;
  });
  const missing = GA_FIELDS.filter((f, i) => fieldIdx[i] === -1).map(f => f.key);
  Logger.log(brand.name + ' GA — using tab "' + tabName + '"' +
    (missing.length ? ' (no match for: ' + missing.join(', ') + ' — written as 0)' : ' (all fields matched)'));

  for (let r = 1; r < values.length; r++) {
    const raw = values[r];
    const dateStr = toDateStr_(raw[dateIdx]);
    if (!dateStr) continue;
    const row = [brand.name, dateStr];
    fieldIdx.forEach(pos => row.push(pos === -1 ? 0 : Number(raw[pos]) || 0));
    out.push(row);
  }
}

/* ─────────────────────────── web app ───────────────────────────── */

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('index');
  t.mode = (e && e.parameter && e.parameter.mode) ? String(e.parameter.mode) : '';
  return t.evaluate()
    .setTitle('We Supply Threads — P&L')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Called from the dashboard via google.script.run. Reads combined_flat + ga_flat only.
 *
 * Field meanings are kept stable for index.html:
 *   spend    — TOTAL ad spend (Meta + Google), so MER / ROAS on the dashboard stays right
 *              once Google Ads is running. meta and google are also returned separately.
 *   printify — production cost from Printify only; printful and gelato are returned
 *              separately, and cogs is all three together.
 */
function getDashboardData() {
  const ss = SpreadsheetApp.openById(COMBINED_ID);

  const flat = ss.getSheetByName(TAB_FLAT);
  if (!flat) throw new Error('combined_flat missing — run setupCombinedBook() then rebuildCombined().');
  const values = flat.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!v[0]) continue;
    const date = toDateStr_(v[1]);
    if (!date) continue;
    const meta = Number(v[7]) || 0;
    const google = Number(v[11]) || 0;
    const printify = Number(v[6]) || 0;
    const printful = Number(v[10]) || 0;
    const gelato = Number(v[12]) || 0;
    rows.push({
      brand: String(v[0]), date: date,
      gross: Number(v[2]) || 0, refunds: Number(v[3]) || 0,
      net: Number(v[4]) || 0, orders: Number(v[5]) || 0,
      printify: printify, printful: printful, gelato: gelato, cogs: printify + printful + gelato,
      spend: meta + google, meta: meta, google: google,
      fees: Number(v[8]) || 0, profit: Number(v[9]) || 0
    });
  }

  const gaSheet = ss.getSheetByName(TAB_GA);
  const ga = [];
  if (gaSheet) {
    const gv = gaSheet.getDataRange().getValues();
    for (let i = 1; i < gv.length; i++) {
      const v = gv[i];
      if (!v[0]) continue;
      const date = toDateStr_(v[1]);
      if (!date) continue;
      ga.push({
        brand: String(v[0]), date: date,
        sessions: Number(v[2]) || 0, users: Number(v[3]) || 0,
        atc: Number(v[4]) || 0, checkouts: Number(v[5]) || 0,
        purchases: Number(v[6]) || 0, revenue: Number(v[7]) || 0
      });
    }
  }

  let brands = [];
  try { brands = getRegistry_().map(b => ({ name: b.name, color: b.color })); } catch (e) {}

  return {
    generatedAt: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
    today: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'),
    brands: brands,
    rows: rows,
    ga: ga
  };
}

/** On-demand: re-pull every brand sheet, then return fresh data. */
function rebuildAndGetData() {
  rebuildCombined();
  return getDashboardData();
}

/* ─────────────────────────── triggers ──────────────────────────── */

/** Hourly rebuild. Replaces any existing rebuildCombined trigger, including the old 7am one. */
function createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'rebuildCombined') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rebuildCombined').timeBased().everyHours(1).create();
  Logger.log('Hourly rebuild trigger set (' + TZ + ').');
}

/** Kept for reference; createHourlyTrigger() supersedes it. */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'rebuildCombined') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('rebuildCombined').timeBased().atHour(7).everyDays(1).create();
  Logger.log('Daily rebuild trigger set for ~7:00 AM (' + TZ + ').');
}
