/**
 * Daily P&L: Shopify revenue − production cost (Printify / Printful) − ad spend (Meta / Google)
 * Writes one row per day to the "daily_pnl" tab.
 *
 * Runs in PP Profit, and in WS Profit (Wallspoke), which is a copy of PP Profit with
 * the same 12-column layout. NOT EE Profit: that sheet has its own script, with a
 * gelato_cost column that shifts every letter from G onward, plus GA4 and the
 * cell-limit hardening. See sheets/ee-pnl. What differs between PP and Wallspoke
 * lives in Script Properties, not in the code:
 *   - Printify is used only if PRINTIFY_TOKEN is set; Printful only if PRINTFUL_TOKEN is.
 *   - Which Meta campaigns count is META_INCLUDE_CAMPAIGNS (required).
 *   - Google Ads spend arrives in the "google_input" tab, written hourly by the Google
 *     Ads script on the manager account. Nothing to configure here.
 *
 * THREE MODES:
 *   - runDaily()         — re-pulls trailing 30 days. Use as the daily trigger.
 *   - runToday()         — pulls TODAY ONLY (one day). Use as an hourly/midday
 *     trigger to keep the intraday "today" pacing tab fresh. The next morning's
 *     runDaily overwrites today's row with the final, complete numbers.
 *   - backfillAllHistory() — walks backwards month-by-month from today to the
 *     beginning of the Shopify store's history. Resumable across runs to handle
 *     Apps Script's 6-minute execution limit. Run manually until it logs
 *     "Backfill complete."
 *
 * Setup:
 *   1. Extensions → Apps Script, paste this in.
 *   2. Project Settings → Script Properties, add:
 *        SHOPIFY_STORE          e.g. "elder-emo"
 *        SHOPIFY_CLIENT_ID
 *        SHOPIFY_CLIENT_SECRET
 *        META_ACCESS_TOKEN      (system user token, never expires)
 *        META_AD_ACCOUNT_ID     (numeric id, no "act_" prefix)
 *      and whichever production vendor the brand uses:
 *        PRINTIFY_TOKEN + PRINTIFY_SHOP_ID          (Elder Emo, PopPunks)
 *        PRINTFUL_TOKEN + PRINTFUL_STORE_ID         (Wallspoke)
 *        META_INCLUDE_CAMPAIGNS (REQUIRED) campaign-name substring(s) to keep, comma
 *                               separated, or "all". PopPunks: "poppunks".
 *   3. Run `setup` once to create / update the tabs and headers.
 *   4. Run `applyGoogleFormulas` once so every existing row picks up google_spend.
 *   4b. Run `testChannels`, then `backfillChannels` until it says complete, to fill the
 *       channel columns (M..T) for past days. See the Channels section at the end.
 *   5. For full history: run `backfillAllHistory` repeatedly until done.
 *   6. Triggers → daily time-based trigger for `runDaily`.
 *
 * Important: Shopify only returns orders from the last 60 days unless your
 * app has the `read_all_orders` scope (a protected scope). Request approval
 * in the Dev Dashboard, add the scope, and reinstall the app before backfilling.
 *
 * Meta spend: pulled automatically from the Insights API. The "meta_input" tab
 * remains as a manual OVERRIDE — if a date is present there, that value wins
 * over the API. Leave the tab empty to use API values everywhere.
 *
 * CHANGELOG
 *   2026-10: added printful_cost (K) and google_spend (L). They sit AFTER last_updated
 *            on purpose: every dashboard formula addresses daily_pnl by column letter,
 *            so appending keeps A..J exactly where they were. Profit is now
 *            D − F − G − H − K − L, total costs include K and L, and MER is net revenue
 *            over TOTAL ad spend (Meta + Google), not Meta alone.
 */

const SHEET_NAME = 'daily_pnl';
const GOOGLE_TAB = 'google_input';
const LOOKBACK_DAYS = 30;
const SHOPIFY_API_VERSION = '2026-01';
const META_API_VERSION = 'v21.0';

// Which Meta campaigns count toward this brand's spend is set PER SHEET in the
// META_INCLUDE_CAMPAIGNS script property, never in code:
//   "poppunks"      — keep only campaigns whose name contains "poppunks"
//   "a, b"          — keep campaigns matching any of the comma-separated substrings
//   "all"           — keep every campaign in the ad account
// Matching is case-insensitive. Elder Emo and PopPunks share one Meta ad account,
// which is why the filter exists at all (EE's script excludes "poppunks"; this one
// keeps only it). It is deliberately NOT a constant: this file also runs in the
// Wallspoke sheet, which has its own ad account and wants "all", and a hardcoded
// default copied across would silently drop that brand's spend. A missing property
// stops the run instead.

// Shopify Payments fee estimate. Defaults are standard Shopify plan (2.9% + $0.30).
// Adjust if you're on Advanced (2.6% + $0.30) or Shopify Plus (varies).
const SHOPIFY_FEE_PERCENT = 0.029;
const SHOPIFY_FEE_FIXED = 0.30;

// Printful order statuses that do NOT count as a cost: a draft was never submitted
// (it is waiting in Backstage's Approvals tab), and failed / canceled orders are not
// charged. Everything else (pending, inprocess, onhold, partial, fulfilled, archived)
// has been submitted and counts on the day the order was created.
const PRINTFUL_UNCHARGED_STATUSES = ['draft', 'failed', 'canceled', 'cancelled'];

// Backfill config
const BACKFILL_CHUNK_DAYS = 30;          // process one month per chunk
const BACKFILL_MAX_RUNTIME_MS = 5 * 60 * 1000;  // exit before the 6-min limit
const BACKFILL_CHECKPOINT_KEY = 'backfill_cursor';  // ISO date we've processed back to

// Last-run timestamps, recorded by each entry point so every dashboard tab can
// stamp its own data-freshness. We keep TWO separate keys (not the daily_pnl
// last_updated column) because both runDaily and runToday write that column, so
// it can't say WHICH run last refreshed a given tab. runToday stamps the "today"
// tab; runDaily stamps all the other tabs.
const LAST_RUN_DAILY_KEY = 'last_run_daily';
const LAST_RUN_TODAY_KEY = 'last_run_today';

// daily_pnl column numbers (1-based). A..J are the original layout; K and L were
// appended. Every formula below is written against THIS layout.
const C = {
  date: 1, revenue: 2, refunds: 3, net: 4, orders: 5, printify: 6, meta: 7,
  fees: 8, profit: 9, updated: 10, printful: 11, google: 12,
  // Channels (see the Channels section at the end of this file).
  shMetaOrders: 13, shMetaRev: 14, shGoogleOrders: 15, shGoogleRev: 16,
  metaConv: 17, metaValue: 18, googleConv: 19, googleValue: 20,
};

// ---------- Entry points ----------

function setup() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  // Column layout: A..J unchanged since gelato_cost was removed, then K and L appended.
  // Safe to re-run on an existing sheet: it only rewrites the header row.
  const headers = [
    'date',              // A
    'shopify_revenue',   // B
    'shopify_refunds',   // C
    'shopify_net',       // D
    'shopify_orders',    // E
    'printify_cost',     // F
    'meta_spend',        // G
    'shopify_fees_est',  // H
    'profit',            // I
    'last_updated',      // J
    'printful_cost',     // K
    'google_spend',      // L
    'shopify_meta_orders',    // M  Shopify-attributed: last visit came from Meta
    'shopify_meta_revenue',   // N
    'shopify_google_orders',  // O  Shopify-attributed: last visit was a Google ad click
    'shopify_google_revenue', // P
    'meta_purchases',         // Q  Meta-reported, 7-day click + 1-day view
    'meta_purchase_value',    // R
    'google_conversions',     // S  Google-reported "Conversions" (formula, google_input C)
    'google_conv_value',      // T  (formula, google_input D)
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  // meta_input tab is now an OVERRIDE for Meta spend. If a date has a row here,
  // its value wins over the API-fetched spend. Leave empty to use API values.
  let metaSheet = ss.getSheetByName('meta_input');
  if (!metaSheet) {
    metaSheet = ss.insertSheet('meta_input');
    metaSheet.getRange(1, 1, 1, 2).setValues([['date', 'meta_spend_override']]).setFontWeight('bold');
    metaSheet.setFrozenRows(1);
    // Format date column so VLOOKUP matches reliably.
    metaSheet.getRange('A:A').setNumberFormat('yyyy-mm-dd');
  }

  // google_input is written by the Google Ads script on the manager account. Created
  // here so the google_spend formulas have something to look at before its first run.
  let googleSheet = ss.getSheetByName(GOOGLE_TAB);
  if (!googleSheet) {
    googleSheet = ss.insertSheet(GOOGLE_TAB);
    googleSheet.getRange(1, 1, 1, 2).setValues([['date', 'google_spend']]).setFontWeight('bold');
    googleSheet.setFrozenRows(1);
    googleSheet.getRange('A:A').setNumberFormat('yyyy-mm-dd');
  }

  Logger.log('Setup complete.');
}

/**
 * One-time migration for an existing sheet. Puts the google_spend lookup formula on
 * every row, and updates the profit formula to subtract K and L — but ONLY where profit
 * is still the standard =D-F-G-H formula. Older rows carrying a hand-entered or legacy
 * profit (e.g. from the gelato era) are left alone, so history does not quietly change.
 * Safe to re-run.
 */
function applyGoogleFormulas() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Run setup() first.');
  const last = sheet.getLastRow();
  if (last < 2) return;

  const n = last - 1;
  const profitRange = sheet.getRange(2, C.profit, n, 1);
  const formulas = profitRange.getFormulas();
  const values = profitRange.getValues();
  const google = [];
  const profit = [];
  let updated = 0, kept = 0;
  for (let i = 0; i < n; i++) {
    const row = i + 2;
    google.push([googleFormula_(row)]);
    const f = String(formulas[i][0]).replace(/\s/g, '').toUpperCase();
    const standard = f === `=D${row}-F${row}-G${row}-H${row}` || f === profitFormula_(row).toUpperCase();
    if (standard) { profit.push([profitFormula_(row)]); updated++; }
    // Kept rows are written back exactly as they were: their formula, or their value.
    else { profit.push([formulas[i][0] || values[i][0]]); kept++; }
  }
  sheet.getRange(2, C.google, n, 1).setFormulas(google);
  profitRange.setValues(profit);  // one write; strings starting "=" are stored as formulas
  Logger.log('google_spend formula set on ' + n + ' rows. Profit updated on ' + updated +
    ' rows; left ' + kept + ' rows with a non-standard profit value untouched.');
}

/**
 * Builds (or rebuilds) two dashboard tabs:
 *   - "dashboard_mtd"  : month-to-date KPIs vs the same span of last month, charts scoped to this month
 *   - "dashboard_30d"  : last-30-days KPIs vs the prior 30 days, charts scoped to the last 30 days
 * Safe to re-run — clears and rebuilds both. KPIs are live formulas; charts are
 * scoped by writing the relevant window's rows into a hidden helper area and
 * pointing the charts at that, so they show the timeframe and not all-time.
 */
function buildDashboard() {
  const ss = SpreadsheetApp.getActive();
  const data = ss.getSheetByName(SHEET_NAME);
  if (!data) throw new Error('daily_pnl tab not found — run setup() first.');

  // Build order is the REVERSE of the desired left-to-right tab order: every
  // builder inserts its tab at position 0 (leftmost), so whichever is built
  // LAST ends up furthest left. Building ytd→mtd→30d→7d→yesterday→today yields
  // the display order: today, yesterday, dashboard_7d, dashboard_30d,
  // dashboard_mtd, dashboard_ytd.
  buildYTDForecast_(ss, data);
  buildDashboardMTD_(ss, data);
  buildDashboard30d_(ss, data);
  buildDashboard7d_(ss, data);
  buildYesterdaySnapshot_(ss, data);
  buildTodaySnapshot_(ss, data);

  // Remove the legacy single-tab dashboard if it exists from an earlier version.
  const legacy = ss.getSheetByName('dashboard');
  if (legacy) ss.deleteSheet(legacy);

  Logger.log('Dashboards built (left to right): "today", "yesterday", "dashboard_7d", "dashboard_30d", "dashboard_mtd", "dashboard_ytd".');
}

// ----- shared helpers -----

/** Which production vendors this brand uses, from which tokens are configured. */
function vendors_() {
  const p = PropertiesService.getScriptProperties();
  return { printify: !!p.getProperty('PRINTIFY_TOKEN'), printful: !!p.getProperty('PRINTFUL_TOKEN') };
}

/**
 * Date-keyed lookup of a daily_pnl column. Matches on the TEXT form of the date
 * (yyyy-mm-dd) first, then the date serial, so it works whether column A holds
 * real dates or text strings. Range is A:L.
 */
function lk_(col, dayExpr) {
  return `IFERROR(VLOOKUP(TEXT(${dayExpr},"yyyy-mm-dd"),${DATA}!$A:$L,${col},FALSE),` +
    `IFERROR(VLOOKUP(${dayExpr},${DATA}!$A:$L,${col},FALSE),0))`;
}

/**
 * Builds a "yesterday" tab: a clean single-day readout for yesterday's numbers,
 * with a day-over-day comparison against the day before. Uses live lookup
 * formulas keyed on date, so it always reflects the latest daily_pnl data.
 *
 * Yesterday is TODAY()-1. We avoid "today" because today's row is still
 * mid-collection until the next morning's run, so it would read artificially low.
 * Today's in-progress numbers live on the separate "today" tab, which paces them
 * against where yesterday stood at the same hour.
 */
function buildYesterdaySnapshot_(ss, data) {
  let sh = ss.getSheetByName('yesterday');
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet('yesterday', 0);  // index 0 = leftmost tab, first thing you see
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 4, 150);

  // Header with the actual date shown.
  sh.getRange('A1').setValue('Yesterday').setFontSize(20).setFontWeight('bold');
  sh.getRange('A2').setFormula('=TEXT(TODAY()-1,"dddd, mmmm d, yyyy")')
    .setFontSize(11).setFontColor('#666');
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  const lk = lk_;
  const Y = 'TODAY()-1';   // yesterday
  const Y2 = 'TODAY()-2';  // day before
  const v = vendors_();

  // Costs (every cost column) and ad spend (Meta + Google) for a given day.
  const costs = (dayExpr) =>
    `(${lk(C.printify, dayExpr)}+${lk(C.printful, dayExpr)}+${lk(C.meta, dayExpr)}+` +
    `${lk(C.google, dayExpr)}+${lk(C.fees, dayExpr)})`;
  const ads = (dayExpr) => `(${lk(C.meta, dayExpr)}+${lk(C.google, dayExpr)})`;

  // Rows: [label, yesterdayFormula, dayBeforeFormula (for delta), numberFormat, indent?]
  // Production rows appear only for the vendor(s) this brand actually uses.
  const rows = [
    ['Net Revenue',      lk(C.net, Y),     lk(C.net, Y2),     '$#,##0.00', false],
    ['Orders',           lk(C.orders, Y),  lk(C.orders, Y2),  '#,##0',     false],
    ['—',                null,             null,              null,        false],
  ];
  if (v.printify || !v.printful) rows.push(['Printify', lk(C.printify, Y), lk(C.printify, Y2), '$#,##0.00', true]);
  if (v.printful) rows.push(['Printful', lk(C.printful, Y), lk(C.printful, Y2), '$#,##0.00', true]);
  rows.push(
    ['Meta',             lk(C.meta, Y),    lk(C.meta, Y2),    '$#,##0.00', true],
    ['Google',           lk(C.google, Y),  lk(C.google, Y2),  '$#,##0.00', true],
    ['Shopify Fees',     lk(C.fees, Y),    lk(C.fees, Y2),    '$#,##0.00', true],
    ['Total Costs',      costs(Y),         costs(Y2),         '$#,##0.00', false],
    ['—',                null,             null,              null,        false],
    ['Profit',           lk(C.profit, Y),  lk(C.profit, Y2),  '$#,##0.00', false],
    ['Margin %',
      `IFERROR(${lk(C.profit, Y)}/${lk(C.net, Y)},0)`,
      `IFERROR(${lk(C.profit, Y2)}/${lk(C.net, Y2)},0)`,
      '0.0%', false],
    ['—',                null,             null,              null,        false],
    ['MER (rev/ad$)',
      `IFERROR(${lk(C.net, Y)}/${ads(Y)},0)`,
      `IFERROR(${lk(C.net, Y2)}/${ads(Y2)},0)`,
      '0.00"x"', false],
    ['Profit / Order',
      `IFERROR(${lk(C.profit, Y)}/${lk(C.orders, Y)},0)`,
      `IFERROR(${lk(C.profit, Y2)}/${lk(C.orders, Y2)},0)`,
      '$#,##0.00', false],
  );

  // Column headers for the table.
  let r = 4;
  sh.getRange(r, 2).setValue('Yesterday').setFontWeight('bold').setFontColor('#666');
  sh.getRange(r, 3).setValue('vs. day before').setFontWeight('bold').setFontColor('#666');
  r++;

  rows.forEach((row) => {
    const [label, curF, priorF, fmt, indent] = row;
    if (label === '—') { r++; return; }  // spacer row

    const labelCell = sh.getRange(r, 1);
    labelCell.setValue((indent ? '   ' : '') + label);
    if (!indent) labelCell.setFontWeight('bold');
    else labelCell.setFontColor('#444');

    // Value
    sh.getRange(r, 2).setFormula('=' + curF).setNumberFormat(fmt)
      .setFontWeight(indent ? 'normal' : 'bold');

    // Day-over-day delta as %
    if (priorF) {
      const delta =
        `=IFERROR(IF((${priorF})=0,"—",((${curF})-(${priorF}))/ABS(${priorF})),"—")`;
      sh.getRange(r, 3).setFormula(delta).setNumberFormat('+0.0%;−0.0%')
        .setFontColor('#666');
    }
    r++;
  });

  sh.getRange(r + 1, 1).setValue('Snapshot of TODAY()-1. Updates with each morning run.')
    .setFontSize(9).setFontColor('#999');
}

/**
 * Builds a "today" tab: an intraday pacing snapshot of today's numbers so far,
 * compared against where yesterday stood at the same point in the day.
 *
 * Why a separate tab from "yesterday": today's daily_pnl row is incomplete until
 * the next morning's runDaily overwrites it with finals, so it can't be read as
 * a finished day. This tab is fed by the intraday runToday() trigger and is for
 * *direction during the day*, not reconciliation. Yesterday's finished numbers
 * live on the "yesterday" tab.
 *
 * Pacing math (flow metrics — revenue, orders, costs, profit): "where yesterday
 * stood at this hour" is approximated as yesterday's FULL-DAY value times the
 * fraction of today elapsed, MAX((NOW()-TODAY()),0.01). NOW()-TODAY() is the
 * elapsed-day fraction — NOW() is a datetime serial, TODAY() is midnight, so the
 * difference is the fractional day. It's computed LIVE in the cell via NOW(), so
 * the pace stays accurate between script runs (the sheet recalculates NOW() on
 * its own). The 0.01 floor prevents a divide-by-zero right at midnight.
 *
 * MER is a ratio, not a flow that accumulates linearly, so it is NOT paced —
 * today's MER-so-far is compared to yesterday's full-day MER directly.
 */
function buildTodaySnapshot_(ss, data) {
  let sh = ss.getSheetByName('today');
  if (sh) ss.deleteSheet(sh);
  // Position 0 = leftmost. buildDashboard builds this LAST so it wins the
  // leftmost slot ahead of "yesterday" and the dashboard tabs.
  sh = ss.insertSheet('today', 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 4, 150);

  sh.getRange('A1').setValue('Today').setFontSize(20).setFontWeight('bold');
  // Show the date and the time of last sheet recalculation, so it's obvious how
  // "fresh" the pacing fraction is when you glance at it.
  sh.getRange('A2').setFormula('=TEXT(TODAY(),"dddd, mmmm d, yyyy")&"  •  as of "&TEXT(NOW(),"h:mm AM/PM")')
    .setFontSize(11).setFontColor('#666');
  // Data-pull stamp (runToday). Distinct from the A2 "as of" time above, which is
  // the sheet's live recalc time driving the pacing fraction — this is when the
  // numbers were last actually fetched.
  stampLastUpdated_(sh, 'A3', LAST_RUN_TODAY_KEY, ss.getSpreadsheetTimeZone());

  const lk = lk_;
  const T = 'TODAY()';      // today (in progress)
  const Y = 'TODAY()-1';    // yesterday, full day — the pace baseline
  const v = vendors_();

  // Fraction of today elapsed, computed live and floored so midnight (fraction
  // ~0) can't divide by zero.
  const frac = 'MAX((NOW()-TODAY()),0.01)';
  // Paced baseline for a flow metric = yesterday's full-day value * elapsed fraction.
  const paced = (col) => `(${lk(col, Y)}*${frac})`;
  // % delta of today-so-far vs the paced baseline, guarded against /0.
  const paceDelta = (col) =>
    `IFERROR((${lk(col, T)}-${paced(col)})/${paced(col)},"—")`;

  // Today's MER so far, and yesterday's full-day MER (the direct comparison).
  // Both over TOTAL ad spend, Meta + Google.
  const ads = (dayExpr) => `(${lk(C.meta, dayExpr)}+${lk(C.google, dayExpr)})`;
  const merToday = `IFERROR(${lk(C.net, T)}/${ads(T)},0)`;
  const merYestFull = `IFERROR(${lk(C.net, Y)}/${ads(Y)},0)`;

  // Rows: [label, todaySoFarFormula, comparisonDeltaFormula (or null), fmt, indent?]
  const rows = [
    ['Net Revenue',   lk(C.net, T),      paceDelta(C.net),      '$#,##0.00', false],
    ['Orders',        lk(C.orders, T),   paceDelta(C.orders),   '#,##0',     false],
    ['—',             null,              null,                  null,        false],
    ['Meta Spend',    lk(C.meta, T),     paceDelta(C.meta),     '$#,##0.00', true],
    ['Google Spend',  lk(C.google, T),   paceDelta(C.google),   '$#,##0.00', true],
  ];
  if (v.printify || !v.printful) rows.push(['Printify Cost', lk(C.printify, T), paceDelta(C.printify), '$#,##0.00', true]);
  if (v.printful) rows.push(['Printful Cost', lk(C.printful, T), paceDelta(C.printful), '$#,##0.00', true]);
  rows.push(
    ['Shopify Fees',  lk(C.fees, T),     paceDelta(C.fees),     '$#,##0.00', true],
    ['—',             null,              null,                  null,        false],
    ['Profit',        lk(C.profit, T),   paceDelta(C.profit),   '$#,##0.00', false],
    ['—',             null,              null,                  null,        false],
    ['MER (rev/ad$)', merToday,
      // Ratio: compare to yesterday's FULL-DAY MER directly, not a paced value.
      `IFERROR((${merToday}-${merYestFull})/${merYestFull},"—")`,
      '0.00"x"', false],
  );

  // Column headers.
  let r = 4;
  sh.getRange(r, 2).setValue('So far today').setFontWeight('bold').setFontColor('#666');
  sh.getRange(r, 3).setValue('pace vs yesterday').setFontWeight('bold').setFontColor('#666');
  r++;

  rows.forEach((row) => {
    const [label, curF, deltaF, fmt, indent] = row;
    if (label === '—') { r++; return; }  // spacer row

    const labelCell = sh.getRange(r, 1);
    labelCell.setValue((indent ? '   ' : '') + label);
    if (!indent) labelCell.setFontWeight('bold');
    else labelCell.setFontColor('#444');

    sh.getRange(r, 2).setFormula('=' + curF).setNumberFormat(fmt)
      .setFontWeight(indent ? 'normal' : 'bold');

    if (deltaF) {
      sh.getRange(r, 3).setFormula('=' + deltaF).setNumberFormat('+0.0%;−0.0%')
        .setFontColor('#666');
    }
    r++;
  });

  // Footer caveats — pacing is a rough directional tool, not a ledger.
  let f = r + 1;
  const notes = [
    'Pacing assumes spend/sales are spread evenly across the day. Use the deltas for direction, not exact reconciliation.',
    'Treat sub-5% deltas as noise.',
    'Mid-morning Profit may overstate reality: production cost only counts orders already submitted to production, so early-day cost lags revenue.',
    'Google spend updates hourly from the Google Ads script, independently of this script’s runs.',
    'Today’s row is in progress until tomorrow’s runDaily overwrites it with finals. Finished numbers live on the "yesterday" tab.',
  ];
  notes.forEach((n) => {
    sh.getRange(f, 1).setValue(n).setFontSize(9).setFontColor('#999');
    f++;
  });
}

// ----- shared helpers (dashboards) -----

const DATA = SHEET_NAME;  // 'daily_pnl'

/** Sum a single column over rows whose date is between two date-formulas (inclusive lower, exclusive upper). */
function sumBetween_(col, lowerExpr, upperExpr) {
  return `SUMPRODUCT((${DATA}!$A$2:$A>=${lowerExpr})*(${DATA}!$A$2:$A<${upperExpr})*${DATA}!${col}$2:${col})`;
}
/** Sum of several columns over the same window. Blank cells (older rows) count as 0. */
function sumColsBetween_(cols, lowerExpr, upperExpr) {
  return `SUMPRODUCT((${DATA}!$A$2:$A>=${lowerExpr})*(${DATA}!$A$2:$A<${upperExpr})*(${cols.map((c) => `${DATA}!${c}$2:${c}`).join('+')}))`;
}
/**
 * Sum of all cost columns over the same window:
 * F printify, G meta, H fees, K printful, L google.
 */
function sumCostsBetween_(lowerExpr, upperExpr) {
  return sumColsBetween_(['F', 'G', 'H', 'K', 'L'], lowerExpr, upperExpr);
}
/** MER (blended ROAS) = sum(net revenue) / sum(Meta + Google spend) over the window. */
function merBetween_(lowerExpr, upperExpr) {
  return `IFERROR(${sumBetween_('D', lowerExpr, upperExpr)}/${sumColsBetween_(['G', 'L'], lowerExpr, upperExpr)},0)`;
}
/** Contribution margin per order = sum(profit) / sum(orders) over the window. Profit is col I. */
function profitPerOrderBetween_(lowerExpr, upperExpr) {
  return `IFERROR(${sumBetween_('I', lowerExpr, upperExpr)}/${sumBetween_('E', lowerExpr, upperExpr)},0)`;
}

/**
 * Writes a small "Last updated …" line to a cell on a dashboard tab, read from
 * the script property where the relevant entry point records its run time:
 *   - the "today" tab passes LAST_RUN_TODAY_KEY  (set by runToday())
 *   - every other tab passes LAST_RUN_DAILY_KEY  (set by runDaily())
 * The timestamp is formatted in the sheet's timezone. If that entry point hasn't
 * run yet (e.g. you ran buildDashboard by hand before the first trigger fired),
 * it shows a clear "not yet recorded" message instead of a blank or a lie.
 */
function stampLastUpdated_(sh, cellA1, propKey, tz) {
  const iso = PropertiesService.getScriptProperties().getProperty(propKey);
  const runName = (propKey === LAST_RUN_TODAY_KEY) ? 'runToday' : 'runDaily';
  let text;
  if (iso) {
    const when = Utilities.formatDate(new Date(iso), tz, 'EEE, MMM d, yyyy h:mm a z');
    text = 'Last updated ' + when + ' (' + runName + ')';
  } else {
    text = 'Last updated: not yet recorded — run ' + runName + ' to set this.';
  }
  sh.getRange(cellA1).setValue(text).setFontSize(10).setFontColor('#888');
}

/**
 * Year-to-date dashboard with a scenario forecast.
 *
 * Top: the same YTD KPIs used on the other tabs (Revenue, Costs, Profit,
 * Margin, MER, Profit/Order) for Jan 1..today 2026, compared to the same span
 * of 2025.
 *
 * Forecast: rather than extrapolate this year's distorted growth multiple, we
 * project the full year under fixed scenarios — last year's monthly actuals
 * lifted by +5%, +10%, +20%. Past/current 2026 months use actuals; future
 * months use the 2025 same-month actual times (1 + lift). Drawn as a line graph
 * of CUMULATIVE revenue so you can see which scenario you're tracking toward.
 */
function buildYTDForecast_(ss, data) {
  let sh = ss.getSheetByName('dashboard_ytd');
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet('dashboard_ytd', 0);  // position 0; see buildDashboard for ordering
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 9, 120);
  sh.setColumnWidth(1, 150);

  sh.getRange('A1').setValue('Year to Date + Forecast').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('YTD actuals (Jan 1–today) vs. the same span of 2025; full-year forecast scenarios below')
    .setFontSize(10).setFontColor('#666');

  // ---- YTD KPI cards (same metrics as the other tabs) ----
  const cy = 'DATE(2026,1,1)';
  const cyUp = '(TODAY()+1)';
  const ly = 'DATE(2025,1,1)';               // last-year YTD-equivalent lower
  const lyUp = '(EDATE(TODAY(),-12)+1)';     // same span last year, upper

  const kpis = [
    ['Revenue (net)',
      `=${sumBetween_('D', cy, cyUp)}`,
      `=${sumBetween_('D', ly, lyUp)}`, '$#,##0'],
    ['Total Costs',
      `=${sumCostsBetween_(cy, cyUp)}`,
      `=${sumCostsBetween_(ly, lyUp)}`, '$#,##0'],
    ['Profit',
      `=${sumBetween_('I', cy, cyUp)}`,
      `=${sumBetween_('I', ly, lyUp)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('I', cy, cyUp)}/${sumBetween_('D', cy, cyUp)},0)`,
      `=IFERROR(${sumBetween_('I', ly, lyUp)}/${sumBetween_('D', ly, lyUp)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(cy, cyUp)}`,
      `=${merBetween_(ly, lyUp)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(cy, cyUp)}`,
      `=${profitPerOrderBetween_(ly, lyUp)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  // ---- Scenario forecast helper table (hidden, drives the line graph) ----
  // Helper columns: L month, M cumulative ACTUAL, N +5% cum, O +10% cum, P +20% cum.
  // These are scratch columns on THIS dashboard tab (not daily_pnl).
  const hRow = 14;
  sh.getRange(hRow, 12, 1, 5)
    .setValues([['Month', 'Actual', '+5%', '+10%', '+20%']]);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  for (let m = 1; m <= 12; m++) {
    const row = hRow + m;
    const s26 = `DATE(2026,${m},1)`;
    const e26 = `EDATE(DATE(2026,${m},1),1)`;
    const s25 = `DATE(2025,${m},1)`;
    const e25 = `EDATE(DATE(2025,${m},1),1)`;
    const started = `(TODAY()>=${s26})`;

    const act = sumBetween_('D', s26, e26);   // 2026 month revenue
    const ly25 = sumBetween_('D', s25, e25);  // 2025 month revenue

    sh.getRange(row, 12).setValue(monthNames[m - 1]);

    // Cumulative ACTUAL (col M): running total while the month has started,
    // then NA() so the solid line ends at the present instead of dropping.
    const prevM = m === 1 ? '0' : `M${row - 1}`;
    sh.getRange(row, 13).setFormula(`=IF(${started},${prevM}+${act},NA())`)
      .setNumberFormat('$#,##0');

    // Scenario cumulative (cols N,O,P): actual if the month started, else the
    // 2025 month lifted by the scenario %. Added to the prior cumulative.
    const prevN = m === 1 ? '0' : `N${row - 1}`;
    const prevO = m === 1 ? '0' : `O${row - 1}`;
    const prevP = m === 1 ? '0' : `P${row - 1}`;
    sh.getRange(row, 14).setFormula(`=${prevN}+IF(${started},${act},${ly25}*1.05)`).setNumberFormat('$#,##0');
    sh.getRange(row, 15).setFormula(`=${prevO}+IF(${started},${act},${ly25}*1.10)`).setNumberFormat('$#,##0');
    sh.getRange(row, 16).setFormula(`=${prevP}+IF(${started},${act},${ly25}*1.20)`).setNumberFormat('$#,##0');
  }

  sh.hideColumns(12, 5);  // hide L:P

  // ---- Line chart: cumulative revenue, actual vs three scenarios ----
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(`L${hRow + 1}:L${hRow + 12}`))
    .addRange(sh.getRange(`M${hRow + 1}:M${hRow + 12}`))
    .addRange(sh.getRange(`N${hRow + 1}:N${hRow + 12}`))
    .addRange(sh.getRange(`O${hRow + 1}:O${hRow + 12}`))
    .addRange(sh.getRange(`P${hRow + 1}:P${hRow + 12}`))
    .setPosition(14, 1, 0, 0)
    .setOption('title', 'Cumulative Revenue: Actual vs Forecast Scenarios')
    .setOption('width', 760).setOption('height', 420)
    .setOption('colors', ['#1a1a1a', '#57a773', '#0969da', '#8250df'])
    .setOption('series', {
      0: { labelInLegend: 'Actual', lineWidth: 4 },
      1: { labelInLegend: '+5% vs 2025', lineWidth: 2, lineDashStyle: [4, 4] },
      2: { labelInLegend: '+10% vs 2025', lineWidth: 2, lineDashStyle: [4, 4] },
      3: { labelInLegend: '+20% vs 2025', lineWidth: 2, lineDashStyle: [4, 4] },
    })
    .setOption('interpolateNulls', false)
    .build();
  sh.insertChart(chart);

  sh.getRange(hRow + 14, 1).setValue(
    'Scenarios apply a fixed % lift to each remaining month’s 2025 actual revenue, ' +
    'added to actuals so far. Solid black (actuals) ends at today; dashed lines project ' +
    'year-end under each growth assumption.'
  ).setFontSize(9).setFontColor('#999');
}

/**
 * Writes a KPI block with current value, prior-period value, and % delta.
 * rows: array of [label, currentFormula, priorFormula, numberFormat]
 * Lays out 4 KPIs per row, each occupying 2 columns (A,C,E,G), wrapping to a
 * new row of cards after every 4. Each card row uses 3 sheet rows
 * (label/value/delta) plus a 1-row gap.
 * Some KPIs (e.g. per-order, MER) aren't a simple % delta — pass priorFormula
 * as null to omit the delta line for that card.
 */
function writeKpiBlock_(sheet, labelRow, kpis) {
  kpis.forEach((k, i) => {
    const colIdx = i % 4;
    const rowBlock = Math.floor(i / 4);
    const col = 1 + colIdx * 2;            // A, C, E, G
    const baseRow = labelRow + rowBlock * 4;  // 3 rows per card + 1 gap
    const [label, curFormula, priorFormula, fmt] = k;

    sheet.getRange(baseRow, col).setValue(label).setFontSize(11).setFontColor('#666');
    sheet.getRange(baseRow + 1, col).setFormula(curFormula).setNumberFormat(fmt)
      .setFontSize(22).setFontWeight('bold');

    if (priorFormula) {
      const cur = curFormula.slice(1);     // strip '='
      const prior = priorFormula.slice(1);
      const deltaFormula =
        `=IFERROR(IF((${prior})=0,"—",((${cur})-(${prior}))/ABS(${prior})),"—")`;
      sheet.getRange(baseRow + 2, col).setFormula(deltaFormula)
        .setNumberFormat('+0.0%;−0.0%').setFontSize(11).setFontColor('#666');
    }
    sheet.getRange(baseRow, col, 3, 2).setBackground('#f6f6f6');
  });
}

/**
 * Populates a hidden helper area (starting at helperCol) on `sheet` with the
 * rows from daily_pnl whose date falls in [lowerExpr, upperExpr), via a FILTER
 * formula. Charts then point here so they only show the relevant window.
 *
 * Helper layout (one FILTER spilling into 8 columns):
 *   N date, O net, P profit, Q printify, R meta, S fees, T printful, U google
 * and V = 7-day rolling average of profit. The first six keep their old positions;
 * printful and google were appended, which moved the rolling average from T to V.
 */
function writeHelperFilter_(sheet, helperColLetter, lowerExpr, upperExpr) {
  const formula =
    `=IFERROR(FILTER({${DATA}!A2:A,${DATA}!D2:D,${DATA}!I2:I,${DATA}!F2:F,${DATA}!G2:G,${DATA}!H2:H,` +
    `${DATA}!K2:K,${DATA}!L2:L},` +
    `(${DATA}!A2:A>=${lowerExpr})*(${DATA}!A2:A<${upperExpr})),"")`;
  sheet.getRange(`${helperColLetter}2`).setFormula(formula);
  // Header row for clarity (optional, charts use ranges not headers).
  sheet.getRange(`${helperColLetter}1`).setValue('date');
  // Force the spilled date column to render as dates (not serial numbers) so
  // chart x-axes read correctly.
  sheet.getRange(`${helperColLetter}2:${helperColLetter}400`).setNumberFormat('yyyy-mm-dd');

  // 7-day rolling average of profit, in column V (one past the 8 spilled cols N..U).
  // Still reads from column P, which is still profit in the helper layout.
  sheet.getRange('V1').setValue('profit_7dma');
  const rolling = [];
  for (let row = 2; row <= 400; row++) {
    const from = Math.max(2, row - 6);
    rolling.push([`=IF($N${row}="","",AVERAGE($P${from}:$P${row}))`]);
  }
  sheet.getRange(2, 22, rolling.length, 1).setFormulas(rolling);  // col 22 = V
  sheet.getRange('V2:V400').setNumberFormat('$#,##0.00');
}

/** Builds a KPI + chart tab for one window. Shared by the 7d, 30d and MTD tabs. */
function buildWindowTab_(ss, name, title, subtitle, curLower, curUpper, priorLower, priorUpper, chartLabel) {
  let sh = ss.getSheetByName(name);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(name, 0);  // position 0; see buildDashboard for ordering
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 8, 130);

  sh.getRange('A1').setValue(title).setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue(subtitle).setFontSize(10).setFontColor('#666');
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  const kpis = [
    ['Revenue (net)',
      `=${sumBetween_('D', curLower, curUpper)}`,
      `=${sumBetween_('D', priorLower, priorUpper)}`, '$#,##0'],
    ['Total Costs',
      `=${sumCostsBetween_(curLower, curUpper)}`,
      `=${sumCostsBetween_(priorLower, priorUpper)}`, '$#,##0'],
    ['Profit',
      `=${sumBetween_('I', curLower, curUpper)}`,
      `=${sumBetween_('I', priorLower, priorUpper)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('I', curLower, curUpper)}/${sumBetween_('D', curLower, curUpper)},0)`,
      `=IFERROR(${sumBetween_('I', priorLower, priorUpper)}/${sumBetween_('D', priorLower, priorUpper)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(curLower, curUpper)}`,
      `=${merBetween_(priorLower, priorUpper)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(curLower, curUpper)}`,
      `=${profitPerOrderBetween_(priorLower, priorUpper)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);

  // Hidden helper area for scoped charts: N..V (8 spilled columns + profit_7dma).
  writeHelperFilter_(sh, 'N', curLower, curUpper);
  sh.hideColumns(14, 9);  // hide N..V

  insertScopedCharts_(sh, chartLabel);
}

function buildDashboardMTD_(ss, data) {
  // Current MTD: from first of this month (inclusive) to tomorrow (exclusive).
  // Prior period: same number of days, last month.
  buildWindowTab_(ss, 'dashboard_mtd', 'Month to Date', 'vs. same days of last month',
    'DATE(YEAR(TODAY()),MONTH(TODAY()),1)', '(TODAY()+1)',
    'EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-1)',
    '(EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-1)+DAY(TODAY()))',
    'this month');
}

function buildDashboard30d_(ss, data) {
  // Current 30d: [today-29, tomorrow). Prior 30d: [today-59, today-29).
  buildWindowTab_(ss, 'dashboard_30d', 'Last 30 Days', 'vs. the prior 30 days',
    '(TODAY()-29)', '(TODAY()+1)', '(TODAY()-59)', '(TODAY()-29)', 'last 30 days');
}

function buildDashboard7d_(ss, data) {
  // Current 7d: [today-6, tomorrow). Prior 7d: [today-13, today-6).
  buildWindowTab_(ss, 'dashboard_7d', 'Last 7 Days', 'vs. the prior 7 days',
    '(TODAY()-6)', '(TODAY()+1)', '(TODAY()-13)', '(TODAY()-6)', 'last 7 days');
}

/**
 * Inserts the three charts on `sheet`, pointing at the hidden helper area so they
 * show only the scoped window. Helper layout:
 *   N date, O net, P profit, Q printify, R meta, S fees, T printful, U google, V profit_7dma
 * We give generous row depth (400) since the helper spills dynamically.
 */
function insertScopedCharts_(sheet, label) {
  const H = 400;  // helper depth to cover the window
  const r = (a) => sheet.getRange(`${a}2:${a}${H}`);
  const v = vendors_();

  const profitChart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(r('N')).addRange(r('P')).addRange(r('V'))  // date, profit, 7-day avg
    .setPosition(12, 1, 0, 0)
    .setOption('title', 'Daily Profit (' + label + ')')
    .setOption('width', 520).setOption('height', 260)
    .setOption('colors', ['#1a7f37', '#bbbbbb'])
    .setOption('series', {
      0: { labelInLegend: 'Daily', lineWidth: 1 },
      1: { labelInLegend: '7-day avg', lineWidth: 3 },
    })
    .build();
  sheet.insertChart(profitChart);

  const revChart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(r('N')).addRange(r('O')).addRange(r('P'))  // date, net, profit
    .setPosition(12, 6, 0, 0)
    .setOption('title', 'Revenue vs Profit (' + label + ')')
    .setOption('width', 520).setOption('height', 260)
    .setOption('colors', ['#0969da', '#1a7f37'])
    .setOption('series', { 0: { labelInLegend: 'Net Revenue' }, 1: { labelInLegend: 'Profit' } })
    .build();
  sheet.insertChart(revChart);

  // Cost breakdown: production vendor(s) this brand uses, then Meta, Google, fees.
  const series = [];
  if (v.printify || !v.printful) series.push({ col: 'Q', label: 'Printify', color: '#cf222e' });
  if (v.printful) series.push({ col: 'T', label: 'Printful', color: '#bf3989' });
  series.push(
    { col: 'R', label: 'Meta', color: '#8250df' },
    { col: 'U', label: 'Google', color: '#0969da' },
    { col: 'S', label: 'Shopify Fees', color: '#999999' },
  );
  let costChart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(r('N'));
  series.forEach((s) => { costChart = costChart.addRange(r(s.col)); });
  const seriesOpt = {};
  series.forEach((s, i) => { seriesOpt[i] = { labelInLegend: s.label }; });
  costChart = costChart
    .setPosition(26, 1, 0, 0)
    .setOption('title', 'Cost Breakdown by Day (' + label + ')')
    .setOption('isStacked', true)
    .setOption('width', 1050).setOption('height', 300)
    .setOption('colors', series.map((s) => s.color))
    .setOption('series', seriesOpt)
    .build();
  sheet.insertChart(costChart);
}

function runDaily() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const today = new Date();
  const start = new Date(today.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // Floor both ends to the start of their calendar day in the sheet timezone, so
  // we pull whole days (00:00 to 00:00) rather than partial hours from "now".
  // end is the start of *tomorrow* so today is included as a full day.
  const startFloor = startOfDayInTz(start, tz);
  const endFloor = startOfDayInTz(new Date(today.getTime() + 24 * 60 * 60 * 1000), tz);
  processWindow(startFloor, endFloor, tz);

  // Record when this daily run pulled data, so every non-today tab can stamp its
  // freshness. Set BEFORE buildDashboard so the build reads the just-updated value.
  PropertiesService.getScriptProperties().setProperty(LAST_RUN_DAILY_KEY, new Date().toISOString());

  // Refresh the dashboard so its charts pick up any newly-added rows. Wrapped in
  // try/catch so a dashboard hiccup can never block or fail the data pull itself —
  // the data is the important part; the dashboard is just a view of it.
  try {
    buildDashboard();
  } catch (e) {
    Logger.log('Dashboard refresh skipped: ' + e.message);
  }
}

/**
 * Intraday entry point. Pulls TODAY ONLY — the window
 * [startOfDayInTz(now), startOfDayInTz(now + 24h)), which is exactly today's
 * calendar day in the sheet timezone — then refreshes the "today" tab.
 *
 * Use this on an hourly or midday time-based trigger so the "today" pacing tab
 * tracks in near-real-time. The next morning's runDaily re-pulls the trailing
 * window and overwrites today with the final, complete numbers — so any intraday
 * partials are self-healing.
 */
function runToday() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const now = new Date();
  const startFloor = startOfDayInTz(now, tz);
  const endFloor = startOfDayInTz(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
  processWindow(startFloor, endFloor, tz);

  PropertiesService.getScriptProperties().setProperty(LAST_RUN_TODAY_KEY, new Date().toISOString());

  // runToday refreshes ONLY the "today" tab — it must not call buildDashboard(),
  // which would rebuild and re-stamp the daily-cadence tabs. Those tabs are live
  // formulas over daily_pnl, so they still reflect today's row on the next recalc.
  try {
    buildTodaySnapshot_(ss, ss.getSheetByName(SHEET_NAME));
  } catch (e) {
    Logger.log('today tab refresh skipped: ' + e.message);
  }
}

/**
 * Returns a Date at 00:00:00 of the given instant's calendar day, in tz.
 * Uses the same formatDate call the rest of the script uses for day bucketing,
 * so window edges and per-order day assignment agree.
 */
function startOfDayInTz(date, tz) {
  const ymd = Utilities.formatDate(date, tz, 'yyyy-MM-dd');         // calendar day in tz
  const offset = Utilities.formatDate(date, tz, 'Z');               // e.g. "-0400"
  // Insert the colon so Date parsing is reliable: -0400 -> -04:00
  const off = offset.slice(0, 3) + ':' + offset.slice(3);
  return new Date(ymd + 'T00:00:00' + off);
}

/**
 * Resumable backfill. Each run processes one month at a time, walking backwards,
 * until it either reaches the beginning of the Shopify store or runs out of time.
 * Just run it again to resume.
 */
function backfillAllHistory() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const props = PropertiesService.getScriptProperties();
  const startTime = Date.now();

  // Resume from checkpoint, or start from today.
  let cursorIso = props.getProperty(BACKFILL_CHECKPOINT_KEY);
  let cursor = cursorIso ? new Date(cursorIso) : new Date();

  Logger.log('Backfill starting. Cursor: ' + cursor.toISOString());

  let chunksProcessed = 0;
  let reachedBeginning = false;

  while (Date.now() - startTime < BACKFILL_MAX_RUNTIME_MS) {
    const chunkEnd = new Date(cursor);
    const chunkStart = new Date(cursor.getTime() - BACKFILL_CHUNK_DAYS * 24 * 60 * 60 * 1000);

    Logger.log(`Chunk: ${chunkStart.toISOString().substring(0,10)} to ${chunkEnd.toISOString().substring(0,10)}`);

    const result = processWindow(chunkStart, chunkEnd, tz);
    chunksProcessed++;

    // If Shopify returned zero orders for this chunk AND we've gone back at least
    // 90 days, assume we've reached the beginning of the store's history.
    const daysBack = (Date.now() - chunkStart.getTime()) / (24 * 60 * 60 * 1000);
    if (result.shopifyOrders === 0 && daysBack > 90) {
      Logger.log('No Shopify orders in this chunk — assuming start of store reached.');
      reachedBeginning = true;
      break;
    }

    cursor = chunkStart;
    props.setProperty(BACKFILL_CHECKPOINT_KEY, cursor.toISOString());
  }

  if (reachedBeginning) {
    props.deleteProperty(BACKFILL_CHECKPOINT_KEY);
    Logger.log(`Backfill complete. Processed ${chunksProcessed} chunks this run.`);
  } else {
    Logger.log(`Time limit approaching. Processed ${chunksProcessed} chunks. Run backfillAllHistory again to resume from ${cursor.toISOString().substring(0,10)}.`);
  }
}

/** Manually reset the backfill checkpoint if you want to start over. */
function resetBackfillCheckpoint() {
  PropertiesService.getScriptProperties().deleteProperty(BACKFILL_CHECKPOINT_KEY);
  Logger.log('Backfill checkpoint cleared.');
}

function getPrintifyShops() {
  const token = mustProp('PRINTIFY_TOKEN');
  const res = UrlFetchApp.fetch('https://api.printify.com/v1/shops.json', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  Logger.log(res.getContentText());
}

/** Lists the Printful stores the token can see, to find PRINTFUL_STORE_ID. */
function getPrintfulStores() {
  const token = mustProp('PRINTFUL_TOKEN');
  const res = UrlFetchApp.fetch('https://api.printful.com/stores', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  Logger.log(res.getContentText());
}

function testShopifyAuth() {
  CacheService.getScriptCache().remove('shopify_access_token');
  const token = getShopifyAccessToken();
  Logger.log('Got Shopify token (length ' + token.length + '). First 8 chars: ' + token.substring(0, 8));
}

// ---------- Core: process a date window ----------

function processWindow(start, end, tz) {
  const v = vendors_();
  const shopify = fetchShopifyByDay(start, end, tz);
  const printify = v.printify ? fetchPrintifyByDay(start, end, tz) : {};
  const printful = v.printful ? fetchPrintfulByDay(start, end, tz) : {};
  const meta = fetchMetaDaily_(start, end, tz);

  const days = {};
  for (const d of allDatesBetween(start, end, tz)) {
    days[d] = blankDay(d);
  }
  for (const [d, val] of Object.entries(shopify)) Object.assign(days[d] || (days[d] = blankDay(d)), val);
  for (const [d, val] of Object.entries(printify)) (days[d] || (days[d] = blankDay(d))).printify_cost = val;
  for (const [d, val] of Object.entries(printful)) (days[d] || (days[d] = blankDay(d))).printful_cost = val;
  for (const [d, val] of Object.entries(meta.spend)) (days[d] || (days[d] = blankDay(d))).meta_spend = val;
  for (const [d, val] of Object.entries(meta.purchases)) (days[d] || (days[d] = blankDay(d))).meta_purchases = val;
  for (const [d, val] of Object.entries(meta.value)) (days[d] || (days[d] = blankDay(d))).meta_purchase_value = val;

  const rows = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  writeRows(rows);

  // Return summary so backfill can detect when it's hit the beginning of history.
  const shopifyOrders = rows.reduce((s, r) => s + (r.shopify_orders || 0), 0);
  return { shopifyOrders };
}

// ---------- Shopify auth ----------

function getShopifyAccessToken() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('shopify_access_token');
  if (cached) return cached;

  const store = mustProp('SHOPIFY_STORE');
  const clientId = mustProp('SHOPIFY_CLIENT_ID');
  const clientSecret = mustProp('SHOPIFY_CLIENT_SECRET');

  const url = `https://${store}.myshopify.com/admin/oauth/access_token`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Shopify auth failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  const token = data.access_token;
  if (!token) throw new Error('Shopify auth: no access_token in response: ' + res.getContentText());

  cache.put('shopify_access_token', token, 21600);
  return token;
}

// ---------- Shopify orders ----------

function fetchShopifyByDay(start, end, tz) {
  const store = mustProp('SHOPIFY_STORE');
  const token = getShopifyAccessToken();
  const base = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json`;

  // For backfill, bound by created_at directly (we want all orders in this window,
  // not just ones recently updated). updated_at would miss old orders that haven't
  // changed recently.
  const params = [
    'status=any',
    'limit=250',
    `created_at_min=${start.toISOString()}`,
    `created_at_max=${end.toISOString()}`,
  ];
  let url = `${base}?${params.join('&')}`;

  const byDay = {};
  let safety = 200;  // higher cap for backfill — months with lots of orders

  while (url && safety-- > 0) {
    const res = UrlFetchApp.fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Shopify orders (' + res.getResponseCode() + '): ' + res.getContentText());
    }
    const data = JSON.parse(res.getContentText());

    for (const order of data.orders || []) {
      if (order.cancelled_at) continue;
      const day = Utilities.formatDate(new Date(order.created_at), tz, 'yyyy-MM-dd');

      const gross = parseFloat(order.total_price || '0');
      const refunds = (order.refunds || []).reduce((sum, r) => {
        return sum + (r.transactions || []).reduce((s, t) => s + parseFloat(t.amount || '0'), 0);
      }, 0);

      const slot = byDay[day] || (byDay[day] = {
        shopify_revenue: 0,
        shopify_refunds: 0,
        shopify_orders: 0,
        meta_orders: 0, meta_revenue: 0, google_orders: 0, google_revenue: 0,
      });
      slot.shopify_revenue += gross;
      slot.shopify_refunds += refunds;
      slot.shopify_orders += 1;

      // Which ad channel Shopify credits with this order (see orderChannel_).
      const channel = orderChannel_(order);
      if (channel) {
        slot[channel + '_orders'] += 1;
        slot[channel + '_revenue'] += gross - refunds;
      }
    }

    url = parseNextLink(res.getAllHeaders()['Link'] || res.getAllHeaders()['link']);
  }

  return byDay;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const m = String(linkHeader).match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

/**
 * The Run button in the Apps Script editor calls functions with NO arguments,
 * so debugDay('...') from the toolbar passes undefined. Edit the date here and
 * run THIS function instead.
 */
function debugDayRunner() {
  debugDay('2026-04-27');
}

/**
 * Diagnostic: dumps every order that buckets to a given ET day, with the fields
 * that matter for reconciliation. Run debugDayRunner() (edit the date there) and
 * read the Logs. Pulls a 3-day window around the target to catch tz-edge orders.
 */
function debugDay(targetYmd) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const store = mustProp('SHOPIFY_STORE');
  const token = getShopifyAccessToken();
  const base = `https://${store}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json`;

  // Window: target day -1 through target day +1, to see edge cases.
  const startFloor = startOfDayInTz(new Date(targetYmd + 'T12:00:00-04:00'), tz);
  const start = new Date(startFloor.getTime() - 24 * 3600 * 1000);
  const end = new Date(startFloor.getTime() + 2 * 24 * 3600 * 1000);

  const params = [
    'status=any',
    'limit=250',
    `created_at_min=${start.toISOString()}`,
    `created_at_max=${end.toISOString()}`,
  ];
  let url = `${base}?${params.join('&')}`;

  let sumTotalPrice = 0, sumCurrentTotal = 0, sumSubtotal = 0, count = 0;
  const lines = [];

  while (url) {
    const res = UrlFetchApp.fetch(url, {
      headers: { 'X-Shopify-Access-Token': token },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('ERR ' + res.getResponseCode() + ': ' + res.getContentText());
      return;
    }
    const data = JSON.parse(res.getContentText());
    for (const o of data.orders || []) {
      const day = Utilities.formatDate(new Date(o.created_at), tz, 'yyyy-MM-dd');
      if (day !== targetYmd) continue;
      count++;
      const tp = parseFloat(o.total_price || '0');
      // current_total_price reflects the order value AFTER edits/refunds.
      const ctp = parseFloat(o.current_total_price || o.total_price || '0');
      const sub = parseFloat(o.subtotal_price || '0');
      sumTotalPrice += tp;
      sumCurrentTotal += ctp;
      sumSubtotal += sub;
      const refundTotal = (o.refunds || []).reduce((s, r) =>
        s + (r.transactions || []).reduce((ss, t) => ss + parseFloat(t.amount || '0'), 0), 0);
      lines.push([
        '#' + (o.name || o.order_number),
        'created=' + Utilities.formatDate(new Date(o.created_at), tz, 'MM-dd HH:mm'),
        'total_price=' + tp.toFixed(2),
        'current_total=' + ctp.toFixed(2),
        'subtotal=' + sub.toFixed(2),
        'tax=' + parseFloat(o.total_tax || '0').toFixed(2),
        'ship=' + ((o.total_shipping_price_set && o.total_shipping_price_set.shop_money && parseFloat(o.total_shipping_price_set.shop_money.amount)) || 0).toFixed(2),
        'disc=' + parseFloat(o.total_discounts || '0').toFixed(2),
        'fin=' + o.financial_status,
        'cancelled=' + (o.cancelled_at ? 'YES' : 'no'),
        'test=' + (o.test ? 'YES' : 'no'),
        'refunded=' + refundTotal.toFixed(2),
        'currency=' + o.currency,
      ].join(' | '));
    }
    url = parseNextLink(res.getAllHeaders()['Link'] || res.getAllHeaders()['link']);
  }

  Logger.log('=== Orders bucketing to ' + targetYmd + ' (ET) ===');
  lines.forEach(l => Logger.log(l));
  Logger.log('--- totals ---');
  Logger.log('order count:            ' + count);
  Logger.log('sum total_price:        ' + sumTotalPrice.toFixed(2) + '   <- what the script currently writes');
  Logger.log('sum current_total_price:' + sumCurrentTotal.toFixed(2) + '   <- after edits/refunds');
  Logger.log('sum subtotal_price:     ' + sumSubtotal.toFixed(2) + '   <- before tax/ship/disc');
}

// ---------- Printify ----------

function fetchPrintifyByDay(start, end, tz) {
  const token = mustProp('PRINTIFY_TOKEN');
  const shopId = mustProp('PRINTIFY_SHOP_ID');
  const base = `https://api.printify.com/v1/shops/${shopId}/orders.json`;

  const startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');

  const byDay = {};
  let page = 1;
  let safety = 500;  // higher cap for backfill

  while (safety-- > 0) {
    const url = `${base}?limit=50&page=${page}`;
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Printify (' + res.getResponseCode() + '): ' + res.getContentText());
    }
    const data = JSON.parse(res.getContentText());

    const orders = data.data || [];
    if (orders.length === 0) break;

    let allOlder = true;
    for (const order of orders) {
      const created = order.created_at;
      if (!created) continue;
      const day = Utilities.formatDate(new Date(created.replace(' ', 'T')), tz, 'yyyy-MM-dd');

      if (day >= startStr) allOlder = false;
      if (day < startStr) continue;
      if (day > endStr) continue;

      // total_price = production, total_shipping = shipping, total_tax = sales tax.
      // All in cents.
      const totalPrice = order.total_price || 0;
      const totalShipping = order.total_shipping || 0;
      const totalTax = order.total_tax || 0;
      const cost = (totalPrice + totalShipping + totalTax) / 100;

      byDay[day] = (byDay[day] || 0) + cost;
    }

    if (allOlder) break;

    const lastPage = data.last_page || (data.meta && data.meta.last_page);
    if (lastPage && page >= lastPage) break;
    page++;
  }

  return byDay;
}

// ---------- Printful ----------

/**
 * Daily Printful cost, bucketed by the day the order was created (sheet timezone),
 * the same rule Printify uses. Only submitted orders count: drafts, failed and
 * canceled orders are skipped (PRINTFUL_UNCHARGED_STATUSES), so a map waiting in
 * Backstage's Approvals tab adds no cost until it is approved.
 *
 * costs.total is what Printful charges: production + shipping + tax/VAT + fees,
 * already in dollars (a string), unlike Printify's cents.
 *
 * Printful lists newest first, so paging stops at the first page that is entirely
 * older than the window.
 */
function fetchPrintfulByDay(start, end, tz) {
  const token = mustProp('PRINTFUL_TOKEN');
  const storeId = PropertiesService.getScriptProperties().getProperty('PRINTFUL_STORE_ID');
  const headers = { Authorization: 'Bearer ' + token };
  if (storeId) headers['X-PF-Store-Id'] = String(storeId);

  const startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');
  const PAGE = 100;

  const byDay = {};
  let skipped = 0;
  for (let page = 0; page < 500; page++) {
    const url = `https://api.printful.com/orders?limit=${PAGE}&offset=${page * PAGE}`;
    const res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Printful (' + res.getResponseCode() + '): ' + res.getContentText());
    }
    const data = JSON.parse(res.getContentText());
    const orders = data.result || [];
    if (orders.length === 0) break;

    let allOlder = true;
    for (const o of orders) {
      if (!o.created) continue;
      const day = Utilities.formatDate(new Date(o.created * 1000), tz, 'yyyy-MM-dd');
      if (day >= startStr) allOlder = false;
      if (day < startStr) continue;
      if (day > endStr) continue;  // same window rule as fetchPrintifyByDay, so the two agree

      const status = String(o.status || '').toLowerCase();
      if (PRINTFUL_UNCHARGED_STATUSES.indexOf(status) !== -1) { skipped++; continue; }

      const cost = parseFloat((o.costs && o.costs.total) || '0') || 0;
      byDay[day] = (byDay[day] || 0) + cost;
    }

    if (allOlder) break;
    const total = data.paging ? data.paging.total : 0;
    if (orders.length < PAGE || (page + 1) * PAGE >= total) break;
  }

  if (skipped) Logger.log('Printful: skipped ' + skipped + ' draft/failed/canceled order(s) in window.');
  return byDay;
}

// ---------- Meta ----------

/** Campaign allowlist from META_INCLUDE_CAMPAIGNS. Empty array = keep everything ("all"). */
function metaIncludes_() {
  const prop = String(PropertiesService.getScriptProperties().getProperty('META_INCLUDE_CAMPAIGNS') || '').trim();
  if (!prop) {
    throw new Error('Missing script property META_INCLUDE_CAMPAIGNS. Set it to the campaign-name ' +
      'substring(s) for this brand (e.g. "poppunks"), or "all" to count every campaign.');
  }
  if (prop.toLowerCase() === 'all') return [];
  return prop.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Pulls daily ad spend from the Meta Marketing Insights API, broken out by
 * campaign so we can exclude specific campaigns from the rolled-up daily total.
 *
 * Endpoint: /act_{id}/insights at level=campaign with time_increment=1 returns
 * one row per (campaign, day), each carrying `spend`, `campaign_name`, and
 * `date_start` (yyyy-MM-dd). We keep ONLY campaigns whose name matches the
 * allowlist (case-insensitive) — see metaIncludes_() — then sum to daily. An
 * empty list disables the filter and includes every campaign.
 *
 * Returns { 'yyyy-MM-dd': number } in the ad account's local currency.
 *
 * Timezone note: Meta buckets `date_start` by the AD ACCOUNT's timezone, which
 * may differ from the spreadsheet timezone. For this account both should match
 * so this aligns naturally. If you ever see Meta off by one day vs Shopify, the
 * fix is to add an explicit timezone in the time_range, or shift the date
 * string here.
 */
function fetchMetaDaily_(start, end, tz) {
  const token = mustProp('META_ACCESS_TOKEN');
  const adAccountId = mustProp('META_AD_ACCOUNT_ID');

  // Meta's time_range.until is INCLUSIVE; our `end` is exclusive (start of
  // tomorrow). So the last day we want is end - 1.
  const since = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const endMinusOne = new Date(end.getTime() - 24 * 3600 * 1000);
  const until = Utilities.formatDate(endMinusOne, tz, 'yyyy-MM-dd');

  // Guard against an empty/inverted window (start >= end).
  if (since > until) return {};

  const timeRange = JSON.stringify({ since: since, until: until });
  const base = `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights`;
  const params = [
    'fields=spend,date_start,campaign_id,campaign_name,actions,action_values',
    // Explicit, so purchases match Ads Manager's default columns whatever the account setting.
    `action_attribution_windows=${encodeURIComponent(JSON.stringify(META_ATTRIBUTION))}`,
    'level=campaign',
    'time_increment=1',
    `time_range=${encodeURIComponent(timeRange)}`,
    'limit=500',
    `access_token=${encodeURIComponent(token)}`,
  ];
  let url = `${base}?${params.join('&')}`;

  const includes = metaIncludes_();
  // When the list is empty we treat the filter as OFF and include everything,
  // so an empty allowlist can never accidentally zero out the whole account.
  const filterOn = includes.length > 0;

  const byDay = {};
  const purchases = {};
  const value = {};
  const droppedSeen = {};  // {campaignName: totalDroppedSpend} for logging
  let safety = 200;  // 500 rows/page * 200 pages covers long backfills

  while (url && safety-- > 0) {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Meta insights (' + res.getResponseCode() + '): ' + res.getContentText());
    }
    const data = JSON.parse(res.getContentText());

    for (const row of data.data || []) {
      const day = row.date_start;  // already yyyy-MM-dd in ad account tz
      const spend = parseFloat(row.spend || '0');
      const bought = metaActionTotal_(row.actions);
      const boughtValue = metaActionTotal_(row.action_values);
      if (!spend && !bought && !boughtValue) continue;

      const name = (row.campaign_name || '').toLowerCase();
      const isIncluded = !filterOn || includes.some((sub) => name.indexOf(sub) !== -1);
      if (!isIncluded) {
        droppedSeen[row.campaign_name] =
          (droppedSeen[row.campaign_name] || 0) + spend;
        continue;
      }

      byDay[day] = (byDay[day] || 0) + spend;
      purchases[day] = (purchases[day] || 0) + bought;
      value[day] = (value[day] || 0) + boughtValue;
    }

    url = (data.paging && data.paging.next) ? data.paging.next : null;
  }

  // Log what we dropped (campaigns that didn't match the include list) so you
  // can sanity-check you're not silently excluding real spend.
  const droppedNames = Object.keys(droppedSeen);
  if (droppedNames.length > 0) {
    Logger.log('Meta: dropped ' + droppedNames.length + ' campaign(s) not matching the include list:');
    droppedNames.forEach(function (n) {
      Logger.log('  - "' + n + '"  $' + droppedSeen[n].toFixed(2));
    });
  }

  return { spend: byDay, purchases: purchases, value: value };
}

/** Daily Meta spend only, for callers that predate purchases (e.g. testMetaInsights). */
function fetchMetaByDay(start, end, tz) {
  return fetchMetaDaily_(start, end, tz).spend;
}

// ---------- Sheet writing ----------

/** meta_spend: the meta_input override if that date has a row, else the API value. */
function metaFormula_(row, apiMeta) {
  return `=IFERROR(VLOOKUP(A${row}, meta_input!A:B, 2, FALSE), ${apiMeta})`;
}
/**
 * google_spend: looked up live from google_input, which the Google Ads script
 * rewrites hourly. Tries the date value, then its yyyy-mm-dd text, then 0, so a
 * date stored as text on either side still matches.
 */
function googleFormula_(row) {
  return `=IFERROR(VLOOKUP(A${row}, ${GOOGLE_TAB}!A:B, 2, FALSE), ` +
    `IFERROR(VLOOKUP(TEXT(A${row},"yyyy-mm-dd"), ${GOOGLE_TAB}!A:B, 2, FALSE), 0))`;
}
/** profit = net − printify − meta − fees − printful − google  (D − F − G − H − K − L) */
function profitFormula_(row) {
  return `=D${row}-F${row}-G${row}-H${row}-K${row}-L${row}`;
}

function writeRows(rows) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Run setup() first.');

  const existing = sheet.getDataRange().getValues();
  const headerRow = existing[0];
  if (headerRow.indexOf('google_spend') === -1) {
    throw new Error('daily_pnl has no google_spend column yet — run setup() once, then applyGoogleFormulas().');
  }
  if (headerRow.indexOf('google_conv_value') === -1) {
    throw new Error('daily_pnl has no channel columns (M..T) yet — run setup() once.');
  }
  const dateColIdx = headerRow.indexOf('date');
  const dateToRow = {};
  for (let i = 1; i < existing.length; i++) {
    const d = existing[i][dateColIdx];
    if (d instanceof Date) {
      dateToRow[Utilities.formatDate(d, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd')] = i + 1;
    } else if (typeof d === 'string' && d) {
      dateToRow[d] = i + 1;
    }
  }

  const now = new Date();

  // Track the API-fetched Meta value per sheet row so we can bake it into the
  // override formula below. Map<rowNum, apiMetaSpend>.
  const metaByRow = new Map();
  const toAppend = [];  // [{values, meta}, ...]

  for (const r of rows) {
    const net = r.shopify_revenue - r.shopify_refunds;
    const feesEst = net > 0
      ? (r.shopify_revenue * SHOPIFY_FEE_PERCENT) + (r.shopify_orders * SHOPIFY_FEE_FIXED)
      : 0;
    // Static values for everything computed from APIs; meta_spend, profit and
    // google_spend are left empty and set as formulas below.
    const rowValues = [
      r.date,                       // A: date
      round2(r.shopify_revenue),    // B
      round2(r.shopify_refunds),    // C
      round2(net),                  // D: shopify_net
      r.shopify_orders,             // E
      round2(r.printify_cost),      // F
      '',                           // G: meta_spend (formula set below)
      round2(feesEst),              // H: shopify_fees_est
      '',                           // I: profit (formula set below)
      now,                          // J: last_updated
      round2(r.printful_cost),      // K: printful_cost
      '',                           // L: google_spend (formula set below)
      r.meta_orders || 0,           // M: shopify_meta_orders
      round2(r.meta_revenue),       // N: shopify_meta_revenue
      r.google_orders || 0,         // O: shopify_google_orders
      round2(r.google_revenue),     // P: shopify_google_revenue
      round2(r.meta_purchases),     // Q: meta_purchases
      round2(r.meta_purchase_value),// R: meta_purchase_value
      '',                           // S: google_conversions (formula set below)
      '',                           // T: google_conv_value (formula set below)
    ];

    const apiMeta = round2(r.meta_spend || 0);
    const existingRow = dateToRow[r.date];
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
      metaByRow.set(existingRow, apiMeta);
    } else {
      toAppend.push({ values: rowValues, meta: apiMeta });
    }
  }

  if (toAppend.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    const valuesOnly = toAppend.map((x) => x.values);
    sheet.getRange(startRow, 1, valuesOnly.length, valuesOnly[0].length).setValues(valuesOnly);
    for (let i = 0; i < toAppend.length; i++) {
      metaByRow.set(startRow + i, toAppend[i].meta);
    }
  }

  // Formulas for meta_spend (G), profit (I) and google_spend (L) on every row touched.
  for (const [row, apiMeta] of metaByRow) {
    sheet.getRange(row, C.meta).setFormula(metaFormula_(row, apiMeta));
    sheet.getRange(row, C.profit).setFormula(profitFormula_(row));
    sheet.getRange(row, C.google).setFormula(googleFormula_(row));
    sheet.getRange(row, C.googleConv, 1, 2).setFormulas([[googleColFormula_(row, 3), googleColFormula_(row, 4)]]);
  }
}

// ---------- Helpers ----------

function mustProp(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error(`Missing script property: ${key}`);
  return v;
}

function blankDay(date) {
  return {
    date,
    shopify_revenue: 0,
    shopify_refunds: 0,
    shopify_orders: 0,
    printify_cost: 0,
    printful_cost: 0,
    meta_spend: 0,
    meta_orders: 0,
    meta_revenue: 0,
    google_orders: 0,
    google_revenue: 0,
    meta_purchases: 0,
    meta_purchase_value: 0,
  };
}

function allDatesBetween(start, end, tz) {
  const out = [];
  const s = new Date(Utilities.formatDate(start, tz, 'yyyy-MM-dd') + 'T00:00:00');
  const e = new Date(Utilities.formatDate(end, tz, 'yyyy-MM-dd') + 'T00:00:00');
  // end is exclusive (it's the start of tomorrow), so use < not <= — otherwise
  // we'd create an empty placeholder row for tomorrow's date.
  for (let d = new Date(s); d < e; d.setDate(d.getDate() + 1)) {
    out.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
  }
  return out;
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

// ---------- Meta token test ----------

/**
 * One-off check that the Meta system-user token works. Hits /me/adaccounts —
 * the most read-only endpoint there is, just lists what the token can see.
 */
function testMetaToken() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('META_ACCESS_TOKEN');
  const adAccountId = props.getProperty('META_AD_ACCOUNT_ID');

  if (!token) {
    Logger.log('❌ META_ACCESS_TOKEN not found in Script Properties.');
    return;
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts`
    + '?fields=account_id,name,account_status'
    + '&access_token=' + encodeURIComponent(token);

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = resp.getResponseCode();
  const body = JSON.parse(resp.getContentText());

  if (code === 200) {
    Logger.log('✅ Token works. Ad accounts this token can see:');
    (body.data || []).forEach(function (a) {
      Logger.log('  • ' + a.name + '  (act_' + a.account_id + ', status ' + a.account_status + ')');
    });
    if (adAccountId) {
      const match = (body.data || []).some(function (a) { return a.account_id === adAccountId; });
      Logger.log(match
        ? '✅ META_AD_ACCOUNT_ID (' + adAccountId + ') is in the list — you\'re good.'
        : '⚠️ META_AD_ACCOUNT_ID (' + adAccountId + ') NOT found — check the ID or the asset assignment.');
    } else {
      Logger.log('⚠️ META_AD_ACCOUNT_ID not set in Script Properties yet.');
    }
  } else {
    Logger.log('❌ HTTP ' + code + ' — token or permission problem:');
    Logger.log(JSON.stringify(body, null, 2));
  }
}

/**
 * One-off check that the Meta Insights API returns daily spend for a recent
 * window. Logs the last 7 days. Useful before kicking off a long backfill.
 */
function testMetaInsights() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const end = startOfDayInTz(new Date(Date.now() + 24 * 3600 * 1000), tz);
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const byDay = fetchMetaByDay(start, end, tz);
  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    Logger.log('No spend rows returned for the last 7 days. Either no spend, or check the ad account ID / permissions.');
    return;
  }
  Logger.log('Meta spend, last 7 days:');
  let total = 0;
  days.forEach(function (d) {
    Logger.log('  ' + d + '  $' + byDay[d].toFixed(2));
    total += byDay[d];
  });
  Logger.log('Total: $' + total.toFixed(2));
}

/** Logs the last 7 days of Printful cost, to check PRINTFUL_TOKEN / PRINTFUL_STORE_ID. */
function testPrintful() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const end = startOfDayInTz(new Date(Date.now() + 24 * 3600 * 1000), tz);
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const byDay = fetchPrintfulByDay(start, end, tz);
  Object.keys(byDay).sort().forEach((d) => Logger.log('  ' + d + '  $' + byDay[d].toFixed(2)));
  if (!Object.keys(byDay).length) Logger.log('No submitted Printful orders in the last 7 days.');
}

// ---------- Channels: Shopify vs platform attribution (columns M..T) ----------
//
// Two views of "how many orders did Meta / Google drive", side by side:
//   Shopify's: each order's own record of the visit that placed it (landing page utm
//     tags and click ids, plus the referring site). Last-visit attribution.
//   The platform's: Meta purchases (7-day click + 1-day view, Ads Manager's default) and
//     Google Ads "Conversions" (primary actions). Platforms credit far more generously,
//     and the gap between the two is the point of collecting both.
// Google organic search is deliberately NOT counted as Google: only paid clicks (gclid /
// gbraid / wbraid, or utm_source=google with a paid medium) are, so organic orders never
// flatter Google ad CPA. Meta cannot be split the same way: Facebook stamps fbclid on
// organic post clicks too, so "Meta" here means Meta ads plus Facebook/Instagram social.

const META_PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const META_ATTRIBUTION = ['7d_click', '1d_view'];
const CHANNEL_CHECKPOINT_KEY = 'channel_backfill_cursor';

/** 'meta', 'google' (paid only) or '' for an order, from Shopify's landing_site / referring_site. */
function orderChannel_(order) {
  const land = String(order.landing_site || '');
  const ref = String(order.referring_site || '').toLowerCase();
  const q = {};
  const qi = land.indexOf('?');
  if (qi !== -1) {
    // Apps Script has no URL class, so the query string is parsed by hand.
    land.slice(qi + 1).split('#')[0].split('&').forEach(function (kv) {
      if (!kv) return;
      const i = kv.indexOf('=');
      const k = (i === -1 ? kv : kv.slice(0, i)).toLowerCase();
      let v = i === -1 ? '' : kv.slice(i + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
      if (!(k in q)) q[k] = v.toLowerCase();
    });
  }
  const hostMatch = ref.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/?#:]+)/);
  const host = hostMatch ? hostMatch[1] : '';
  const src = q.utm_source || '';
  const med = q.utm_medium || '';
  if ('fbclid' in q || /^(facebook|fb|ig|instagram|meta)$/.test(src) || /(^|\.)(facebook|instagram|fb)\.com$/.test(host)) return 'meta';
  if ('gclid' in q || 'gbraid' in q || 'wbraid' in q || (src === 'google' && /cpc|paid|ppc/.test(med))) return 'google';
  return '';
}

/** Purchases (or their value) from one Insights row's actions / action_values list. */
function metaActionTotal_(list) {
  if (!list || !list.length) return 0;
  // These types overlap (omni_purchase includes the pixel's purchases), so take the first
  // one present rather than summing them.
  for (let t = 0; t < META_PURCHASE_TYPES.length; t++) {
    const a = list.find(function (x) { return x.action_type === META_PURCHASE_TYPES[t]; });
    if (!a) continue;
    let n = 0, any = false;
    META_ATTRIBUTION.forEach(function (w) {
      if (a[w] != null) { n += parseFloat(a[w]) || 0; any = true; }
    });
    return any ? n : (parseFloat(a.value) || 0);
  }
  return 0;
}

/** google_input lookup for its Nth column (2 spend, 3 conversions, 4 conversion value). */
function googleColFormula_(row, col) {
  return `=IFERROR(VLOOKUP(A${row}, ${GOOGLE_TAB}!A:D, ${col}, FALSE), ` +
    `IFERROR(VLOOKUP(TEXT(A${row},"yyyy-mm-dd"), ${GOOGLE_TAB}!A:D, ${col}, FALSE), 0))`;
}

/**
 * Fill the channel columns (M..T) for every past day already in daily_pnl, and nothing
 * else. Deliberately not backfillAllHistory: that rewrites whole rows, including profit,
 * and older rows can carry hand-entered values that must not change.
 *
 * Resumable like the other backfills: run it until it logs "Channel backfill complete."
 * It refuses to write zeros over a stretch where Shopify returns no orders but daily_pnl
 * shows some, which is what happens past 60 days when the Shopify app lacks the
 * read_all_orders scope.
 */
function backfillChannels() {
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Run setup() first.');
  if (sheet.getRange(1, 20).getValue() !== 'google_conv_value') {
    throw new Error('daily_pnl has no channel columns yet. Run setup() first.');
  }
  const props = PropertiesService.getScriptProperties();
  const startTime = Date.now();

  const last = sheet.getLastRow();
  const dates = sheet.getRange(2, 1, last - 1, 5).getValues();  // A..E: date .. shopify_orders
  const rowOf = {}, ordersOf = {};
  let earliest = null;
  dates.forEach(function (r, i) {
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') : String(r[0] || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    rowOf[d] = i + 2;
    ordersOf[d] = Number(r[4]) || 0;
    if (!earliest || d < earliest) earliest = d;
  });
  if (!earliest) { Logger.log('daily_pnl is empty; nothing to backfill.'); return; }

  const saved = props.getProperty(CHANNEL_CHECKPOINT_KEY);
  let cursor = saved ? new Date(saved) : startOfDayInTz(new Date(Date.now() + 86400000), tz);
  Logger.log('Channel backfill from ' + Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') + ' back to ' + earliest + '.');

  let chunks = 0, wrote = 0, done = false;
  while (Date.now() - startTime < BACKFILL_MAX_RUNTIME_MS) {
    if (Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') <= earliest) { done = true; break; }
    // Step back whole days; the +3h keeps a DST change from landing the edge at 23:00.
    const chunkStart = startOfDayInTz(new Date(cursor.getTime() - BACKFILL_CHUNK_DAYS * 86400000 + 3 * 3600000), tz);
    const days = allDatesBetween(chunkStart, cursor, tz);

    const shop = fetchShopifyByDay(chunkStart, cursor, tz);
    const sheetOrders = days.reduce(function (s, d) { return s + (ordersOf[d] || 0); }, 0);
    const fetched = Object.keys(shop).reduce(function (s, d) { return s + (shop[d].shopify_orders || 0); }, 0);
    if (sheetOrders > 0 && fetched === 0) {
      throw new Error('Shopify returned no orders for ' + days[0] + ' to ' + days[days.length - 1] +
        ' but daily_pnl records ' + sheetOrders + '. The Shopify app probably lacks read_all_orders, so ' +
        'only the last 60 days are visible. Nothing was written for this stretch; earlier progress is kept.');
    }
    const meta = fetchMetaDaily_(chunkStart, cursor, tz);

    days.forEach(function (d) {
      const row = rowOf[d];
      if (!row) return;
      const s = shop[d] || {};
      sheet.getRange(row, 13, 1, 6).setValues([[
        s.meta_orders || 0, round2(s.meta_revenue || 0),
        s.google_orders || 0, round2(s.google_revenue || 0),
        round2(meta.purchases[d] || 0), round2(meta.value[d] || 0),
      ]]);
      sheet.getRange(row, 19, 1, 2).setFormulas([[googleColFormula_(row, 3), googleColFormula_(row, 4)]]);
      wrote++;
    });

    chunks++;
    cursor = chunkStart;
    props.setProperty(CHANNEL_CHECKPOINT_KEY, cursor.toISOString());
  }

  if (done) {
    props.deleteProperty(CHANNEL_CHECKPOINT_KEY);
    Logger.log('Channel backfill complete. ' + wrote + ' days written in ' + chunks + ' chunks this run.');
  } else {
    Logger.log('Time limit approaching: ' + wrote + ' days written in ' + chunks + ' chunks. Run backfillChannels ' +
      'again to continue from ' + Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') + '.');
  }
}

/** Start the channel backfill over from today. */
function resetChannelBackfill() {
  PropertiesService.getScriptProperties().deleteProperty(CHANNEL_CHECKPOINT_KEY);
  Logger.log('Channel backfill checkpoint cleared.');
}

/** Logs the last 7 days of channel numbers without writing anything. Run before the backfill. */
function testChannels() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const end = startOfDayInTz(new Date(Date.now() + 86400000), tz);
  const start = new Date(end.getTime() - 7 * 86400000);
  const shop = fetchShopifyByDay(start, end, tz);
  const meta = fetchMetaDaily_(start, end, tz);
  allDatesBetween(start, end, tz).forEach(function (d) {
    const s = shop[d] || {};
    Logger.log(d + '  Shopify: Meta ' + (s.meta_orders || 0) + ' orders $' + round2(s.meta_revenue || 0) +
      ', Google ' + (s.google_orders || 0) + ' orders $' + round2(s.google_revenue || 0) +
      '  |  Meta reports ' + round2(meta.purchases[d] || 0) + ' purchases $' + round2(meta.value[d] || 0));
  });
}
