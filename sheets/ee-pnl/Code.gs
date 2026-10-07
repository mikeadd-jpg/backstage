/**
 * Daily P&L: Shopify revenue − Printify cost − Gelato cost − Meta spend − Google spend
 * Writes one row per day to the "daily_pnl" tab.
 *
 * TWO MODES:
 *   - runDaily()         — re-pulls trailing 30 days. Use as the daily trigger.
 *   - runToday()         — re-pulls TODAY only. Use as a midday/intraday trigger
 *                          for a partial-day snapshot. runDaily will overwrite
 *                          today's row with the final numbers the next morning.
 *   - runGADaily()       — re-pulls trailing 30 days of GA4 data only. Use on
 *                          its own time-based trigger LATER in the day (noon
 *                          or end-of-day) so it captures GA4's 24–48h event
 *                          attribution lag. Kept separate from runDaily for
 *                          this freshness reason.
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
 *        PRINTIFY_TOKEN
 *        PRINTIFY_SHOP_ID
 *        GELATO_API_KEY
 *        META_ACCESS_TOKEN      (system user token, never expires)
 *        META_AD_ACCOUNT_ID     (numeric id, no "act_" prefix)
 *        GA4_PROPERTY_ID        (numeric id from GA4 Admin → Property Details)
 *   3. Enable the Analytics Data advanced service in the editor:
 *        Sidebar → Services → "+" → "Google Analytics Data API" → Add.
 *        Default identifier "AnalyticsData" is what this script references.
 *   4. Run `setup` once to create the sheet tabs (daily_pnl, meta_input,
 *      google_input, ga_daily, ga_by_device, ga_traffic_sources,
 *      ga_landing_pages, ga_products).
 *   5. For full history: run `backfillAllHistory` repeatedly until done.
 *   6. Triggers → daily time-based trigger for `runDaily` (e.g. 5–6am), plus a
 *      separate later-in-the-day trigger for `runGADaily` (e.g. noon or 6pm)
 *      so GA4's event attribution has time to settle.
 *
 * Important: Shopify only returns orders from the last 60 days unless your
 * app has the `read_all_orders` scope (a protected scope). Request approval
 * in the Dev Dashboard, add the scope, and reinstall the app before backfilling.
 *
 * Meta spend: pulled automatically from the Insights API. The "meta_input" tab
 * remains as a manual OVERRIDE — if a date is present there, that value wins
 * over the API. Leave the tab empty to use API values everywhere.
 *
 * Google Ads spend: NOT fetched by this script. The Google Ads script on the
 * "We Supply Threads Holding" manager account writes daily cost into the
 * "google_input" tab every hour, and daily_pnl.google_spend (column L) looks it
 * up with a formula. So Google spend stays current without this script running.
 *
 * GA4: pulled into three tabs on each runDaily (NOT runToday — GA's intraday
 * data is incomplete and not useful for pacing). Default GA4 retention is 14
 * months; extend in Admin → Data Settings → Data Retention to 50 months if you
 * want a longer history. Past data outside the retention window is gone.
 *
 * CHANNELS: columns M..T compare Shopify's attribution with Meta's and Google's own. Run
 * setup(), then testChannels, then backfillChannels until it says complete. See the
 * Channels section at the end of this file.
 *
 * CHANGELOG
 *   2026-10: added google_spend as column L, AFTER last_updated, so every existing
 *            column letter (meta H, fees I, profit J) stays put. Profit is now
 *            D − F − G − H − I − L; total costs include L; MER is net revenue over
 *            TOTAL ad spend (Meta H + Google L). Migration: run setup(), then
 *            applyGoogleFormulas() once. Nothing else in this script changed.
 */

const SHEET_NAME = 'daily_pnl';
const GOOGLE_TAB = 'google_input';
const LOOKBACK_DAYS = 30;
const SHOPIFY_API_VERSION = '2026-01';
const META_API_VERSION = 'v21.0';

// Campaign-name substrings to exclude from daily Meta spend (case-insensitive).
// Any campaign whose name contains ANY of these strings is dropped before we
// sum spend by day. Add or remove freely — the daily run and the backfill both
// honor this list.
const META_EXCLUDED_CAMPAIGN_SUBSTRINGS = ['poppunks'];

// Shopify Payments fee estimate. Defaults are standard Shopify plan (2.9% + $0.30).
// Adjust if you're on Advanced (2.6% + $0.30) or Shopify Plus (varies).
const SHOPIFY_FEE_PERCENT = 0.029;
const SHOPIFY_FEE_FIXED = 0.30;

// Backfill config
const BACKFILL_CHUNK_DAYS = 30;          // process one month per chunk
const BACKFILL_MAX_RUNTIME_MS = 5 * 60 * 1000;  // exit before the 6-min limit
const BACKFILL_CHECKPOINT_KEY = 'backfill_cursor';  // ISO date we've processed back to
const GA_BACKFILL_CHECKPOINT_KEY = 'ga_backfill_cursor';  // same idea, separate cursor for GA backfill
const GA_BACKFILL_TARGET_DAYS = 1460;    // how far back backfillGA4History tries to reach (~4 years). It stops early once GA stops returning data (a few empty chunks in a row), so this is just a generous backstop; raise it if your property somehow holds more.

// Last-run timestamps, recorded by each entry point so every dashboard tab can
// stamp its own data-freshness. We keep TWO separate keys (not the daily_pnl
// last_updated column) because both runDaily and runToday write that column, so
// it can't say WHICH run last refreshed a given tab. runToday stamps the "today"
// tab; runDaily stamps all the other tabs.
const LAST_RUN_DAILY_KEY = 'last_run_daily';
const LAST_RUN_TODAY_KEY = 'last_run_today';

// Helper-area depth per dashboard window. These used to be a flat 400 rows on
// every tab, so the 7-day tab wrote 399 rows of ARRAYFORMULA+SUMIFS to display
// 7 points. Every one of those formulas re-evaluates on each recalc, and the
// "today" tab's NOW() is volatile so recalcs fire constantly. That wasted work
// was being paid over and over on every script write, which is what made even
// the trimmed-down runToday slow: writes block on recalculation. Sizing each
// helper to its own window is the biggest single saving available here. Values
// include slack (a month can be 31 days, a year 366).
// Row ceilings for every formula range that would otherwise be open-ended
// (daily_pnl!$A$2:$A). SUMPRODUCT doing arithmetic on an open range expands it
// to the sheet's whole allocated grid rather than the data extent, so a handful
// of those formulas can cost millions of cell evaluations. SUMIFS and VLOOKUP
// optimize open ranges; SUMPRODUCT does not. Bounding them is what keeps
// dashboard_ytd, which writes by far the most of them, from timing out.
//
// Each ceiling is far above the tab's real growth rate, and a value larger than
// the data is harmless. A value SMALLER than the data would silently drop rows,
// so raise these rather than trim them.
const PNL_MAX_ROWS = 8000;           // daily_pnl: 1 row/day, ~21 years
const GA_DAILY_MAX_ROWS = 8000;      // ga_daily: 1 row/day
const GA_DEVICE_MAX_ROWS = 30000;    // ga_by_device: ~3 rows/day
const GA_TRAFFIC_MAX_ROWS = 150000;  // ga_traffic_sources: hundreds of rows/month

const DEPTH_7D = 15;
const DEPTH_30D = 40;
const DEPTH_MTD = 40;
const DEPTH_YTD = 380;

// daily_pnl width: A..K is the original layout, L (google_spend) was appended.
const PNL_WIDTH = 20;  // A..L, then the channel columns M..T

/**
 * Runs `fn` while holding the script lock, and skips the run entirely if
 * another execution already holds it.
 *
 * Every entry point writes to the same spreadsheet. runToday, runDaily,
 * runGADaily and the two backfills are all on timers or run by hand, and
 * nothing stopped two of them overlapping. Concurrent writes to one document
 * are what produce "Service Spreadsheets failed while accessing document",
 * and they can also corrupt an upsert by reading row positions that another
 * run is busy changing.
 *
 * Skipping (rather than queueing) is deliberate: every one of these entry
 * points re-pulls a trailing window, so a skipped run loses nothing. The next
 * scheduled run picks the data up. A long manual backfill will therefore make
 * the triggers no-op while it works, which is exactly what we want.
 */
function withLock_(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log(label + ': another run holds the lock, skipping this run. ' +
      'Nothing is lost; the next scheduled run will pick up this window.');
    return null;
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Runs `fn`, logs how long it took, returns its result. Used to instrument the
 * slow paths so the Executions log says WHERE the time went instead of only
 * that the limit was hit. If something is still slow after this round of
 * changes, the log will name it directly rather than leaving it to guesswork.
 */
function withRetry_(label, fn) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) ? e.message : e);
      // Sheets service hiccups ("Service Spreadsheets timed out / failed while
      // accessing document") are transient and usually succeed on a retry. Any
      // other error is a real bug and is rethrown immediately rather than
      // retried three times and buried.
      const transient =
        msg.indexOf('Service Spreadsheets') !== -1 ||
        msg.indexOf('Service error') !== -1 ||
        msg.indexOf('timed out') !== -1 ||
        msg.indexOf('Please try again') !== -1 ||
        msg.indexOf('try again later') !== -1;
      if (!transient || attempt === MAX_ATTEMPTS) throw e;
      const waitMs = 3000 * attempt;
      Logger.log(label + ': transient Sheets error on attempt ' + attempt +
        ' (' + msg + '). Retrying in ' + (waitMs / 1000) + 's.');
      Utilities.sleep(waitMs);
    }
  }
}

function timed_(label, fn) {
  const t0 = Date.now();
  const out = fn();
  Logger.log('  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + label);
  return out;
}

// GA4 tabs and their schemas. Five tabs because the five reports answer
// different CRO questions and have different shapes:
//   - ga_daily: site-wide, one row per day. Top-of-funnel + ecommerce funnel +
//     computed rates and economics. The headline "how did the site do".
//   - ga_by_device: date × device. The CRO playbook lives here — mobile vs
//     desktop deltas on each funnel step are the primary diagnostic.
//   - ga_traffic_sources: date × source/medium. Attribution of sessions and
//     purchases to where traffic came from.
//   - ga_landing_pages: date × landing_page × device. Where users ENTER the
//     site, with bounce/engagement/conversion by entry point. The skill calls
//     bounce-rate-by-landing-page a top-of-funnel diagnostic.
//   - ga_products: date × product. Merchandising data — items viewed,
//     add-to-cart rate per product, view-to-purchase rate per product. The
//     skill calls add-to-cart-rate vs product-views the merchandising metric.
const GA_DAILY_TAB = 'ga_daily';
const GA_DAILY_HEADERS = [
  // Raw counts (from API):
  'date', 'sessions', 'total_users', 'new_users',
  'engagement_rate', 'bounce_rate', 'avg_session_duration_sec',
  'view_items', 'add_to_carts', 'checkouts', 'purchases', 'revenue',
  // Computed funnel rates (0..1 fractions):
  'view_item_rate', 'add_to_cart_rate',
  'cart_to_checkout_rate', 'checkout_to_purchase_rate', 'conversion_rate',
  // Computed economics:
  'aov', 'revenue_per_user', 'revenue_per_session',
  'last_updated',
];

const GA_DEVICE_TAB = 'ga_by_device';
const GA_DEVICE_HEADERS = [
  'date', 'device',
  // Raw counts:
  'sessions', 'total_users', 'engaged_sessions',
  'engagement_rate', 'bounce_rate',
  'view_items', 'add_to_carts', 'checkouts', 'purchases', 'revenue',
  // Computed funnel rates:
  'view_item_rate', 'add_to_cart_rate',
  'cart_to_checkout_rate', 'checkout_to_purchase_rate', 'conversion_rate',
  // Computed economics:
  'aov', 'revenue_per_user', 'revenue_per_session',
  'last_updated',
];

const GA_TRAFFIC_TAB = 'ga_traffic_sources';
const GA_TRAFFIC_HEADERS = [
  'date', 'source', 'medium',
  // Raw counts:
  'sessions', 'total_users', 'purchases', 'revenue',
  // Computed:
  'conversion_rate', 'aov', 'revenue_per_user', 'revenue_per_session',
  'last_updated',
];

const GA_LANDING_TAB = 'ga_landing_pages';
const GA_LANDING_HEADERS = [
  'date', 'landing_page', 'device',
  // Raw counts:
  'sessions', 'total_users', 'engaged_sessions',
  'engagement_rate', 'bounce_rate', 'avg_session_duration_sec',
  'view_items', 'add_to_carts', 'purchases', 'revenue',
  // Computed: rates AND economics. Note: no cart_to_checkout / checkout_to_purchase
  // here — checkouts isn't pulled at landing-page level (would push the metric
  // count over GA4's 10/request cap). Get those from the by-device tab instead.
  'view_item_rate', 'add_to_cart_rate', 'conversion_rate',
  'aov', 'revenue_per_user',
  'last_updated',
];

const GA_PRODUCTS_TAB = 'ga_products';
const GA_PRODUCTS_HEADERS = [
  'date', 'product_name',
  // Raw counts (item-scoped metrics, count items not events):
  'items_viewed', 'items_added_to_cart', 'items_checked_out',
  'items_purchased', 'item_revenue',
  // Computed: the merchandising signals from the CRO skill. view_to_purchase_rate
  // is the headline "is this product selling once people see it" metric.
  'add_to_cart_rate', 'view_to_purchase_rate', 'aov_per_item',
  'last_updated',
];

// ---------- Entry points ----------

function setup() {
  // Under the same lock as runDaily / runToday, so an hourly trigger cannot write to
  // the document while setup is restructuring it.
  return withLock_('setup', setupUnlocked_);
}

function setupUnlocked_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  const headers = [
    'date',              // A
    'shopify_revenue',   // B
    'shopify_refunds',   // C
    'shopify_net',       // D
    'shopify_orders',    // E
    'printify_cost',     // F
    'gelato_cost',       // G
    'meta_spend',        // H
    'shopify_fees_est',  // I
    'profit',            // J
    'last_updated',      // K
    'google_spend',      // L  (appended 2026-10)
    'shopify_meta_orders',    // M  Shopify-attributed: last visit came from Meta
    'shopify_meta_revenue',   // N
    'shopify_google_orders',  // O  Shopify-attributed: last visit was a Google ad click
    'shopify_google_revenue', // P
    'meta_purchases',         // Q  Meta-reported, 7-day click + 1-day view
    'meta_purchase_value',    // R
    'google_conversions',     // S  Google-reported "Conversions" (formula, google_input C)
    'google_conv_value',      // T  (formula, google_input D)
  ];
  // trimDataTabGrids keeps only one spare column past the data, so make sure the
  // grid actually has room for column L before writing the header into it.
  withRetry_('setup daily_pnl', function () {
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });

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

  // google_input is written by the Google Ads script on the manager account.
  //
  // Each step checks its own state rather than hanging off "was the tab just
  // created", so a run that dies partway (this document is heavy enough that
  // structural changes can time out) is finished off by simply running setup again.
  let googleSheet = ss.getSheetByName(GOOGLE_TAB);
  if (!googleSheet) {
    googleSheet = withRetry_('setup google_input create', function () { return ss.insertSheet(GOOGLE_TAB); });
  }
  if (googleSheet.getRange('A1').getValue() !== 'date') {
    withRetry_('setup google_input header', function () {
      googleSheet.getRange(1, 1, 1, 2).setValues([['date', 'google_spend']]).setFontWeight('bold');
      googleSheet.setFrozenRows(1);
      googleSheet.getRange('A:A').setNumberFormat('yyyy-mm-dd');
    });
  }
  // Trim to two columns: this spreadsheet has hit Google's 10M-cell ceiling before,
  // and a fresh tab allocates 26 columns it will never use. Best-effort only — it
  // saves ~24k cells, and deleting columns forces a full recalc that can time out
  // on this document. A skipped trim is retried on the next setup run, or done by
  // trimDataTabGrids().
  if (googleSheet.getMaxColumns() > 2) {
    try {
      withRetry_('setup google_input trim', function () {
        googleSheet.deleteColumns(3, googleSheet.getMaxColumns() - 2);
      });
    } catch (e) {
      Logger.log('google_input: column trim skipped (' + e.message + '). Harmless; ' +
        'run setup or trimDataTabGrids again later to reclaim the cells.');
    }
  }

  // GA4 tabs — created idempotently. Safe to re-run setup() if these are
  // missing; existing tabs are left alone (no header rewrite, so any manual
  // tweaks survive). NOTE: if a tab's schema changed in a script update,
  // delete the tab manually and re-run setup() to get the fresh headers.
  ensureGATab_(ss, GA_DAILY_TAB, GA_DAILY_HEADERS);
  ensureGATab_(ss, GA_DEVICE_TAB, GA_DEVICE_HEADERS);
  ensureGATab_(ss, GA_TRAFFIC_TAB, GA_TRAFFIC_HEADERS);
  ensureGATab_(ss, GA_LANDING_TAB, GA_LANDING_HEADERS);
  ensureGATab_(ss, GA_PRODUCTS_TAB, GA_PRODUCTS_HEADERS);

  Logger.log('Setup complete.');
}

/**
 * One-time migration after adding column L. Puts the google_spend lookup formula
 * on every daily_pnl row, and updates the profit formula to subtract L — but ONLY
 * where profit is still the standard =D-F-G-H-I formula. Rows carrying any other
 * profit (a typed value, or a formula from an older layout) are written back exactly
 * as they were, so history does not quietly change. Safe to re-run.
 */
function applyGoogleFormulas() {
  return withLock_('applyGoogleFormulas', function () {
    const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Run setup() first.');
    if (sheet.getRange(1, 12).getValue() !== 'google_spend') {
      throw new Error('daily_pnl has no google_spend header in column L — run setup() first.');
    }
    const last = sheet.getLastRow();
    if (last < 2) return;

    const n = last - 1;
    const profitRange = sheet.getRange(2, 10, n, 1);  // J
    const formulas = profitRange.getFormulas();
    const values = profitRange.getValues();
    const google = [];
    const profit = [];
    let updated = 0, kept = 0;
    for (let i = 0; i < n; i++) {
      const row = i + 2;
      google.push([googleFormula_(row)]);
      const f = String(formulas[i][0]).replace(/\s/g, '').toUpperCase();
      const standard = f === `=D${row}-F${row}-G${row}-H${row}-I${row}` ||
                       f === profitFormula_(row).toUpperCase();
      if (standard) { profit.push([profitFormula_(row)]); updated++; }
      else { profit.push([formulas[i][0] || values[i][0]]); kept++; }
    }
    // Both writes set fixed content, so a retry after a timeout is harmless, and so is
    // re-running this whole function if it still fails.
    withRetry_('applyGoogleFormulas L', function () {
      sheet.getRange(2, 12, n, 1).setFormulas(google);  // L
    });
    withRetry_('applyGoogleFormulas profit', function () {
      profitRange.setValues(profit);  // one write; strings starting "=" are stored as formulas
    });
    Logger.log('google_spend formula set on ' + n + ' rows. Profit updated on ' + updated +
      ' rows; left ' + kept + ' rows with a non-standard profit value untouched.');
  });
}

/**
 * Idempotent helper: create a tab with the given headers if it doesn't exist.
 * Used by setup() for the GA4 tabs. Does not overwrite an existing tab — if you
 * change the schema you must delete the old tab manually.
 */
function ensureGATab_(ss, name, headers) {
  if (ss.getSheetByName(name)) return;
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Format the date column so VLOOKUP and date math behave correctly.
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd');
}

/**
 * Builds (or rebuilds) two dashboard tabs:
 *   - "dashboard_mtd"  : month-to-date KPIs vs the same span of last month, charts scoped to this month
 *   - "dashboard_30d"  : last-30-days KPIs vs the prior 30 days, charts scoped to the last 30 days
 * Safe to re-run — clears and rebuilds both. KPIs are live formulas; charts are
 * scoped by writing the relevant window's rows into a hidden helper area and
 * pointing the charts at that, so they show the timeframe and not all-time.
 */
/**
 * Returns a clean dashboard sheet named `name`, positioned at `position`.
 *
 * Reuses the existing sheet (clearing it) instead of the old delete-then-insert
 * pair. That pair is why the dashboards have been failing outright:
 * ss.insertSheet allocates a brand new 1000 x 26 grid, and Google refuses that
 * once the spreadsheet is at its 10 million cell ceiling. Because the DELETE
 * half succeeds before the INSERT half fails, a failure did not leave the old
 * tab alone, it destroyed it. That is exactly how dashboard_ytd ended up blank
 * for days rather than simply going stale.
 *
 * Clearing and reusing needs no new allocation at all, so it works regardless of
 * how full the document is, and it is faster than recreating a sheet.
 */
function resetDashboardSheet_(ss, name, position) {
  const existing = ss.getSheetByName(name);
  if (!existing) return ss.insertSheet(name, position);

  // Charts are not removed by clear(), so drop them explicitly or they would
  // accumulate on every rebuild.
  existing.getCharts().forEach(function (c) { existing.removeChart(c); });
  // The builders hide helper columns; unhide before clearing so a rebuild
  // starts from a known state.
  if (existing.getMaxColumns() > 0) existing.showColumns(1, existing.getMaxColumns());
  if (existing.getMaxRows() > 0) existing.showRows(1, existing.getMaxRows());
  existing.clear();
  ss.setActiveSheet(existing);
  ss.moveActiveSheet(position + 1);  // moveActiveSheet is 1-based
  return existing;
}

/** Thousands separators without relying on toLocaleString. */
function fmtInt_(n) {
  const s = String(Math.round(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Read-only size audit. Run this from the editor and read the log.
 *
 * Google caps a spreadsheet at 10,000,000 cells, counting every cell in each
 * sheet's ALLOCATED GRID, not just the ones holding data. A tab with 80,000
 * rows and the default 26 columns burns 2.08M cells even if only 12 columns
 * are used. Once the document is near the cap, insertSheet fails, which takes
 * the dashboards down. This reports where the cells actually went.
 */
function auditSpreadsheetSize() {
  const ss = SpreadsheetApp.getActive();
  const sheets = ss.getSheets();
  const LIMIT = 10000000;
  const rows = [];
  let total = 0;
  let reclaimable = 0;

  sheets.forEach(function (sh) {
    const maxR = sh.getMaxRows();
    const maxC = sh.getMaxColumns();
    const cells = maxR * maxC;
    const lastR = sh.getLastRow();
    const lastC = sh.getLastColumn();
    const used = Math.max(lastR, 1) * Math.max(lastC, 1);
    total += cells;
    reclaimable += (cells - used);
    rows.push({ name: sh.getName(), maxR: maxR, maxC: maxC, cells: cells,
                lastR: lastR, lastC: lastC, waste: cells - used });
  });

  rows.sort(function (a, b) { return b.cells - a.cells; });

  Logger.log('=== Spreadsheet size audit ===');
  Logger.log('Sheets: ' + sheets.length);
  rows.forEach(function (r) {
    Logger.log(r.name + ':  grid ' + r.maxR + ' x ' + r.maxC +
      ' = ' + fmtInt_(r.cells) + ' cells  |  data ' + r.lastR + ' x ' + r.lastC +
      '  |  unused ' + fmtInt_(r.waste));
  });
  Logger.log('---');
  Logger.log('TOTAL ALLOCATED: ' + fmtInt_(total) + ' / ' + fmtInt_(LIMIT) +
    ' cells (' + ((total / LIMIT) * 100).toFixed(1) + '% of the hard limit)');
  Logger.log('Reclaimable by trimming unused grid: ' + fmtInt_(reclaimable) + ' cells');
  if (total > LIMIT * 0.9) {
    Logger.log('*** AT OR NEAR THE LIMIT. This is why insertSheet fails and the ' +
      'dashboards cannot rebuild. Run trimDataTabGrids() to reclaim unused grid, ' +
      'and consider capping GA history (see notes on backfillGA4History). ***');
  }
  return total;
}

/**
 * Reclaims unused grid on the DATA tabs by deleting rows and columns past the
 * real data extent (leaving a buffer for growth). Only touches the pure data
 * tabs; the dashboard tabs are left alone because they place charts and notes
 * well below their last data row, and trimming those would move things around.
 *
 * Safe to re-run. Never deletes anything at or above the data extent.
 */
function trimDataTabGrids() {
  return withLock_('trimDataTabGrids', function () {
    const ss = SpreadsheetApp.getActive();
    const DATA_TABS = [SHEET_NAME, 'meta_input', GOOGLE_TAB, GA_DAILY_TAB, GA_DEVICE_TAB,
                       GA_TRAFFIC_TAB, GA_LANDING_TAB, GA_PRODUCTS_TAB];
    const ROW_BUFFER = 200;  // headroom so normal appends never hit the edge
    const COL_BUFFER = 1;
    let reclaimed = 0;

    DATA_TABS.forEach(function (name) {
      const sh = ss.getSheetByName(name);
      if (!sh) return;
      const before = sh.getMaxRows() * sh.getMaxColumns();

      const keepRows = Math.max(sh.getLastRow() + ROW_BUFFER, 100);
      if (sh.getMaxRows() > keepRows) {
        sh.deleteRows(keepRows + 1, sh.getMaxRows() - keepRows);
      }
      const keepCols = Math.max(sh.getLastColumn() + COL_BUFFER, 1);
      if (sh.getMaxColumns() > keepCols) {
        sh.deleteColumns(keepCols + 1, sh.getMaxColumns() - keepCols);
      }

      const after = sh.getMaxRows() * sh.getMaxColumns();
      reclaimed += (before - after);
      Logger.log(name + ': ' + fmtInt_(before) + ' -> ' + fmtInt_(after) +
        ' cells (freed ' + fmtInt_(before - after) + ')');
    });

    Logger.log('Total reclaimed: ' + fmtInt_(reclaimed) + ' cells.');
    Logger.log('Re-run auditSpreadsheetSize() to confirm, then buildDashboard().');
    return reclaimed;
  });
}

function buildDashboard() {
  return withLock_('buildDashboard', buildDashboardUnlocked_);
}

function buildDashboardUnlocked_() {
  const ss = SpreadsheetApp.getActive();
  const data = ss.getSheetByName(SHEET_NAME);
  if (!data) throw new Error('daily_pnl tab not found — run setup() first.');

  // Build in REVERSE of the desired left-to-right order. Each build function
  // inserts its tab at position 0, so the most recently built ends up
  // leftmost. Desired order: today, yesterday, 7d, 30d, mtd, ytd.
  //
  // Each tab is built in ISOLATION: retried on transient Sheets service errors,
  // and its failure caught so it can never stop the remaining tabs. Previously
  // one throw anywhere aborted the whole function, and because dashboard_ytd is
  // both the heaviest tab AND the first one built, a hiccup there left it
  // deleted-and-empty and the other five tabs never rebuilt at all. Now the
  // worst case is one stale tab plus a clear log line naming it.
  const builders = [
    ['dashboard_ytd', function () { buildYTDForecast_(ss, data); }],
    ['dashboard_mtd', function () { buildDashboardMTD_(ss, data); }],
    ['dashboard_30d', function () { buildDashboard30d_(ss, data); }],
    ['dashboard_7d', function () { buildDashboard7d_(ss, data); }],
    ['yesterday', function () { buildYesterdaySnapshot_(ss, data); }],
    ['today', function () { buildTodaySnapshot_(ss, data); }],
  ];

  const failed = [];
  builders.forEach(function (b) {
    const name = b[0];
    try {
      timed_(name, function () { withRetry_(name, b[1]); });
    } catch (e) {
      failed.push(name);
      Logger.log('FAILED to build "' + name + '": ' +
        ((e && e.message) ? e.message : e));
    }
  });

  // Remove the legacy single-tab dashboard if it exists from an earlier version.
  // Wrapped: this is cosmetic cleanup and must never be able to throw away a
  // build where all six tabs succeeded.
  try {
    const legacy = ss.getSheetByName('dashboard');
    if (legacy) ss.deleteSheet(legacy);
  } catch (e) {
    Logger.log('Legacy dashboard cleanup skipped: ' + ((e && e.message) ? e.message : e));
  }

  if (failed.length === 0) {
    Logger.log('Dashboards built: all 6 tabs OK.');
  } else {
    Logger.log('Dashboards built with ' + failed.length + ' failure(s): ' +
      failed.join(', ') + '. The other tabs are current. Re-run buildDashboard ' +
      'to retry the failed one(s).');
  }
  return failed;
}

// ----- shared helpers -----

/**
 * Writes a small "Last updated …" line to a cell on a dashboard tab, read from
 * the script property where the relevant entry point records its run time:
 *   - the "today" tab passes LAST_RUN_TODAY_KEY  (set by runToday())
 *   - every other tab passes LAST_RUN_DAILY_KEY  (set by runDaily())
 * The timestamp is formatted in the sheet's timezone. If that entry point hasn't
 * run yet (e.g. you ran buildDashboard by hand before the first trigger fired),
 * it shows a clear "not yet recorded" message instead of a blank or a lie.
 *
 * Note on the "today" tab specifically: runDaily also refreshes today's row (today
 * is inside its trailing-30 window), but per design this stamp reports the last
 * runToday so the tab's freshness line matches its intraday purpose. Right after a
 * morning runDaily but before that day's first runToday, the data is in fact a bit
 * fresher than this line implies.
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
 * Builds a "today" tab: an intraday pacing readout showing revenue, costs,
 * profit, and MER for the current day, with each metric compared to the same
 * elapsed fraction of yesterday. Designed to answer "should I increase or
 * decrease ad spend right now?" at a glance.
 *
 * Pacing comparison: today's running total vs. (yesterday's full day ×
 * fraction of today elapsed). This assumes revenue/spend distributes evenly
 * across the day, which isn't perfectly true (lunch/evening spikes are real)
 * but is directionally correct enough for a gut-check. A +20% delta means
 * today is meaningfully ahead of yesterday; sub-5% deltas are noise.
 *
 * The "fraction of day elapsed" is computed live in the sheet via NOW() so
 * the comparison stays accurate between script runs — no need to refresh
 * the tab for the comparison to update, just the underlying data totals.
 */
function buildTodaySnapshot_(ss, data) {
  const sh = resetDashboardSheet_(ss, 'today', 0);  // leftmost tab — first thing you see
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 4, 160);

  // Header.
  sh.getRange('A1').setValue('Today — Pacing').setFontSize(20).setFontWeight('bold');
  sh.getRange('A2').setFormula('=TEXT(TODAY(),"dddd, mmmm d, yyyy")')
    .setFontSize(11).setFontColor('#666');
  // A3 = data-freshness stamp (when runToday last pulled). This is the script's
  // last data-fetch time, distinct from any NOW()-driven live calculations in
  // the table below (which use the sheet's recalc clock, not the data clock).
  // Don't deduplicate the two — they answer different questions.
  stampLastUpdated_(sh, 'A3', LAST_RUN_TODAY_KEY, ss.getSpreadsheetTimeZone());
  sh.getRange('A4').setValue('Compares today\'s running total to yesterday\'s pace at this hour')
    .setFontSize(10).setFontColor('#999').setFontStyle('italic');

  // Same VLOOKUP-style fetcher as the yesterday tab, matching on either text
  // or date form of column A. Range A..L (google_spend is L).
  const lk = (col, dayExpr) =>
    `IFERROR(VLOOKUP(TEXT(${dayExpr},"yyyy-mm-dd"),${DATA}!$A$2:$L$${PNL_MAX_ROWS},${col},FALSE),` +
    `IFERROR(VLOOKUP(${dayExpr},${DATA}!$A$2:$L$${PNL_MAX_ROWS},${col},FALSE),0))`;
  // Same fetcher for ga_daily — sessions and conv rate live here, not in daily_pnl.
  // Column index range A:U covers all 21 columns including the computed metrics.
  const gaLk = (col, dayExpr) =>
    `IFERROR(VLOOKUP(TEXT(${dayExpr},"yyyy-mm-dd"),${GA_DAILY_TAB}!$A$2:$U$${GA_DAILY_MAX_ROWS},${col},FALSE),` +
    `IFERROR(VLOOKUP(${dayExpr},${GA_DAILY_TAB}!$A$2:$U$${GA_DAILY_MAX_ROWS},${col},FALSE),0))`;
  const T = 'TODAY()';      // today
  const Y = 'TODAY()-1';    // yesterday (full day, complete)

  // Column index map (1-based, A..L):
  //   A=1 date, B=2 gross, C=3 refunds, D=4 net, E=5 orders,
  //   F=6 printify, G=7 gelato, H=8 meta, I=9 fees, J=10 profit, L=12 google
  const COL = { net: 4, orders: 5, printify: 6, gelato: 7, meta: 8, fees: 9, profit: 10, google: 12 };
  // ga_daily column indices: sessions=2, conversion_rate=17.
  const GA_COL = { sessions: 2, conv_rate: 17 };

  // Total ad spend (Meta + Google) for a day — what MER divides by.
  const ads = (dayExpr) => `(${lk(COL.meta, dayExpr)}+${lk(COL.google, dayExpr)})`;

  // Fraction of today elapsed, live. (NOW() - TODAY()) gives a number of days
  // since midnight, so it's already a 0..1 fraction. Floor at a small positive
  // value to avoid divide-by-zero at midnight; this is a tiny pacing baseline
  // until ~15 minutes into the day.
  const PACE = 'MAX((NOW()-TODAY()),0.01)';

  // Yesterday-at-this-hour expression for a given column: yesterday's full-day
  // value times the elapsed fraction.
  const yPace = (col) => `(${lk(col, Y)}*${PACE})`;
  const gaYPace = (col) => `(${gaLk(col, Y)}*${PACE})`;

  // Rows: [label, todayFormula, paceFormula (yesterday at this hour), numberFormat, indent?]
  // priorFormula = null for derived metrics where a % delta wouldn't be meaningful.
  const rows = [
    ['Revenue',         lk(COL.net, T),        yPace(COL.net),       '$#,##0.00', false],
    ['Orders',          lk(COL.orders, T),     yPace(COL.orders),    '#,##0',     false],
    ['Sessions',        gaLk(GA_COL.sessions, T), gaYPace(GA_COL.sessions), '#,##0', false],
    ['—',               null, null, null, false],
    ['Meta Spend',      lk(COL.meta, T),       yPace(COL.meta),      '$#,##0.00', false],
    ['Google Spend',    lk(COL.google, T),     yPace(COL.google),    '$#,##0.00', false],
    ['Printify Cost',   lk(COL.printify, T),   yPace(COL.printify),  '$#,##0.00', true],
    ['Gelato Cost',     lk(COL.gelato, T),     yPace(COL.gelato),    '$#,##0.00', true],
    ['Shopify Fees',    lk(COL.fees, T),       yPace(COL.fees),      '$#,##0.00', true],
    ['—',               null, null, null, false],
    ['Profit',          lk(COL.profit, T),     yPace(COL.profit),    '$#,##0.00', false],
    ['MER (rev/ad$)',
      `IFERROR(${lk(COL.net, T)}/${ads(T)},0)`,
      // MER comparison: yesterday's MER doesn't depend on pace (it's a ratio)
      // so compare directly to yesterday's full-day MER.
      `IFERROR(${lk(COL.net, Y)}/${ads(Y)},0)`,
      '0.00"x"', false],
    // Conversion rate doesn't get a pace adjustment either — ratios don't
    // accumulate. Comparing today-so-far's rate to yesterday's full-day rate
    // tells you whether today's traffic is converting better or worse than
    // yesterday's audience did overall, which is the read you actually want.
    ['Conv Rate (GA)',  gaLk(GA_COL.conv_rate, T), gaLk(GA_COL.conv_rate, Y), '0.00%', false],
  ];

  // Column headers.
  let r = 5;
  sh.getRange(r, 2).setValue('So far today').setFontWeight('bold').setFontColor('#666');
  sh.getRange(r, 3).setValue('Pace vs yesterday').setFontWeight('bold').setFontColor('#666');
  r++;

  rows.forEach((row) => {
    const [label, curF, priorF, fmt, indent] = row;
    if (label === '—') { r++; return; }

    const labelCell = sh.getRange(r, 1);
    labelCell.setValue((indent ? '   ' : '') + label);
    if (!indent) labelCell.setFontWeight('bold');
    else labelCell.setFontColor('#444');

    sh.getRange(r, 2).setFormula('=' + curF).setNumberFormat(fmt)
      .setFontWeight(indent ? 'normal' : 'bold');

    if (priorF) {
      const delta =
        `=IFERROR(IF((${priorF})=0,"—",((${curF})-(${priorF}))/ABS(${priorF})),"—")`;
      sh.getRange(r, 3).setFormula(delta).setNumberFormat('+0.0%;−0.0%')
        .setFontColor('#666');
    }
    r++;
  });

  // Footer caveats: explain what the numbers do and don't mean so a glance
  // doesn't lead to overreacting to noise. Apps Script auto-runs and there's
  // no real-time push — refreshing the data depends on the trigger schedule.
  r += 1;
  sh.getRange(r, 1).setValue(
    'Pacing assumes revenue and spend distribute evenly across the day. ' +
    'Use the % deltas for direction, not exact reconciliation.'
  ).setFontSize(9).setFontColor('#999');
  r++;
  sh.getRange(r, 1).setValue(
    'Updates each time runDaily or runToday runs. For more frequent refreshes, ' +
    'add an hourly trigger on runToday. Google spend updates hourly on its own, ' +
    'from the Google Ads script.'
  ).setFontSize(9).setFontColor('#999');
}

/**
 * Builds a "yesterday" tab: a clean single-day readout for yesterday's numbers,
 * with a day-over-day comparison against the day before. Uses live lookup
 * formulas keyed on date, so it always reflects the latest daily_pnl data.
 *
 * Yesterday is TODAY()-1. We avoid "today" here because today's row is still
 * mid-collection until the next morning's run, so it would read artificially
 * low. The separate "today" tab handles the in-progress view with pacing.
 */
function buildYesterdaySnapshot_(ss, data) {
  const sh = resetDashboardSheet_(ss, 'yesterday', 0);  // index 0 = leftmost tab, first thing you see
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 4, 150);

  // Header with the actual date shown.
  sh.getRange('A1').setValue('Yesterday').setFontSize(20).setFontWeight('bold');
  sh.getRange('A2').setFormula('=TEXT(TODAY()-1,"dddd, mmmm d, yyyy")')
    .setFontSize(11).setFontColor('#666');
  // A3 = data-freshness stamp (when runDaily last pulled).
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  // A VLOOKUP-style fetch for a given daily_pnl column on a given date.
  // We match on the TEXT form of the date (yyyy-mm-dd) rather than the date
  // serial, so this works whether column A holds real dates or text strings.
  // daily_pnl cols: A date, D net, F printify, G gelato, H meta, I fees, J profit,
  // E orders, L google. Range A..L.
  const lk = (col, dayExpr) =>
    `IFERROR(VLOOKUP(TEXT(${dayExpr},"yyyy-mm-dd"),${DATA}!$A$2:$L$${PNL_MAX_ROWS},${col},FALSE),` +
    `IFERROR(VLOOKUP(${dayExpr},${DATA}!$A$2:$L$${PNL_MAX_ROWS},${col},FALSE),0))`;
  // Same VLOOKUP idea but pointed at ga_daily (A..U, 21 columns).
  const gaLk = (col, dayExpr) =>
    `IFERROR(VLOOKUP(TEXT(${dayExpr},"yyyy-mm-dd"),${GA_DAILY_TAB}!$A$2:$U$${GA_DAILY_MAX_ROWS},${col},FALSE),` +
    `IFERROR(VLOOKUP(${dayExpr},${GA_DAILY_TAB}!$A$2:$U$${GA_DAILY_MAX_ROWS},${col},FALSE),0))`;
  // ga_by_device has a composite key (date, device), so VLOOKUP won't work.
  // SUMIFS gives us the same single-cell value because each (date, device)
  // appears at most once per the GA upsert key. Try date-typed match first,
  // fall back to text-typed match (same dual-pattern as lk above).
  const deviceLk = (colLetter, dayExpr, device) =>
    `IFERROR(SUMIFS(${GA_DEVICE_TAB}!${colLetter}$2:${colLetter}$${GA_DEVICE_MAX_ROWS},${GA_DEVICE_TAB}!$A$2:$A$${GA_DEVICE_MAX_ROWS},${dayExpr},${GA_DEVICE_TAB}!$B$2:$B$${GA_DEVICE_MAX_ROWS},"${device}"),` +
    `IFERROR(SUMIFS(${GA_DEVICE_TAB}!${colLetter}$2:${colLetter}$${GA_DEVICE_MAX_ROWS},${GA_DEVICE_TAB}!$A$2:$A$${GA_DEVICE_MAX_ROWS},TEXT(${dayExpr},"yyyy-mm-dd"),${GA_DEVICE_TAB}!$B$2:$B$${GA_DEVICE_MAX_ROWS},"${device}"),0))`;
  const Y = 'TODAY()-1';   // yesterday
  const Y2 = 'TODAY()-2';  // day before

  // Column index map within A:L (1-based): A=1 date, B=2 gross, C=3 refunds,
  // D=4 net, E=5 orders, F=6 printify, G=7 gelato, H=8 meta, I=9 fees, J=10 profit,
  // L=12 google
  const COL = { net: 4, orders: 5, printify: 6, gelato: 7, meta: 8, fees: 9, profit: 10, google: 12 };
  // ga_daily column indices (1-based): sessions=2, add_to_cart_rate=14,
  // cart_to_checkout_rate=15, checkout_to_purchase_rate=16, conversion_rate=17.
  const GA_COL = {
    sessions: 2, atc_rate: 14, c2c_rate: 15, c2t_rate: 16, conv_rate: 17,
  };
  // ga_by_device column LETTERS (for SUMIFS): G=bounce_rate (7), Q=conv_rate (17).
  const GA_DEV_LETTER = { bounce: 'G', conv_rate: 'Q' };

  // Costs (sum of the five cost columns) for a given day.
  const costs = (dayExpr) =>
    `(${lk(COL.printify, dayExpr)}+${lk(COL.gelato, dayExpr)}+${lk(COL.meta, dayExpr)}+` +
    `${lk(COL.google, dayExpr)}+${lk(COL.fees, dayExpr)})`;
  // Total ad spend (Meta + Google) for a day — what MER divides by.
  const ads = (dayExpr) => `(${lk(COL.meta, dayExpr)}+${lk(COL.google, dayExpr)})`;

  // Rows: [label, yesterdayFormula, dayBeforeFormula (for delta), numberFormat, indent?]
  const rows = [
    ['Net Revenue',      lk(COL.net, Y),     lk(COL.net, Y2),     '$#,##0.00', false],
    ['Orders',           lk(COL.orders, Y),  lk(COL.orders, Y2),  '#,##0',     false],
    ['—',                null,               null,                null,        false],
    ['Printify',         lk(COL.printify, Y),lk(COL.printify, Y2),'$#,##0.00', true],
    ['Gelato',           lk(COL.gelato, Y),  lk(COL.gelato, Y2),  '$#,##0.00', true],
    ['Meta',             lk(COL.meta, Y),    lk(COL.meta, Y2),    '$#,##0.00', true],
    ['Google',           lk(COL.google, Y),  lk(COL.google, Y2),  '$#,##0.00', true],
    ['Shopify Fees',     lk(COL.fees, Y),    lk(COL.fees, Y2),    '$#,##0.00', true],
    ['Total Costs',      costs(Y),           costs(Y2),           '$#,##0.00', false],
    ['—',                null,               null,                null,        false],
    ['Profit',           lk(COL.profit, Y),  lk(COL.profit, Y2),  '$#,##0.00', false],
    ['Margin %',
      `IFERROR(${lk(COL.profit, Y)}/${lk(COL.net, Y)},0)`,
      `IFERROR(${lk(COL.profit, Y2)}/${lk(COL.net, Y2)},0)`,
      '0.0%', false],
    ['—',                null,               null,                null,        false],
    ['MER (rev/ad$)',
      `IFERROR(${lk(COL.net, Y)}/${ads(Y)},0)`,
      `IFERROR(${lk(COL.net, Y2)}/${ads(Y2)},0)`,
      '0.00"x"', false],
    ['Profit / Order',
      `IFERROR(${lk(COL.profit, Y)}/${lk(COL.orders, Y)},0)`,
      `IFERROR(${lk(COL.profit, Y2)}/${lk(COL.orders, Y2)},0)`,
      '$#,##0.00', false],
    // --- CRO block: traffic + funnel + mobile/desktop split ---
    ['—',                null, null, null, false],
    ['Sessions',         gaLk(GA_COL.sessions, Y), gaLk(GA_COL.sessions, Y2), '#,##0',  false],
    ['Conv Rate',        gaLk(GA_COL.conv_rate, Y), gaLk(GA_COL.conv_rate, Y2), '0.00%', false],
    ['ATC Rate',         gaLk(GA_COL.atc_rate, Y), gaLk(GA_COL.atc_rate, Y2), '0.00%', true],
    ['Cart → Checkout',  gaLk(GA_COL.c2c_rate, Y), gaLk(GA_COL.c2c_rate, Y2), '0.00%', true],
    ['Checkout → Purchase', gaLk(GA_COL.c2t_rate, Y), gaLk(GA_COL.c2t_rate, Y2), '0.00%', true],
    ['—',                null, null, null, false],
    // Mobile vs desktop conv rate: the CRO skill's primary diagnostic. A small
    // delta = step-level issue; a 2x+ delta = device-specific issue. Compare
    // each device's yesterday to its own day-before to see if the gap is new.
    ['Conv — Mobile',    deviceLk(GA_DEV_LETTER.conv_rate, Y, 'mobile'),
                         deviceLk(GA_DEV_LETTER.conv_rate, Y2, 'mobile'),
                         '0.00%', false],
    ['Conv — Desktop',   deviceLk(GA_DEV_LETTER.conv_rate, Y, 'desktop'),
                         deviceLk(GA_DEV_LETTER.conv_rate, Y2, 'desktop'),
                         '0.00%', false],
    ['—',                null, null, null, false],
    ['Bounce — Mobile',  deviceLk(GA_DEV_LETTER.bounce, Y, 'mobile'),
                         deviceLk(GA_DEV_LETTER.bounce, Y2, 'mobile'),
                         '0.00%', false],
    ['Bounce — Desktop', deviceLk(GA_DEV_LETTER.bounce, Y, 'desktop'),
                         deviceLk(GA_DEV_LETTER.bounce, Y2, 'desktop'),
                         '0.00%', false],
  ];

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

  // Light divider styling on the Profit row for emphasis.
  // Find profit row: it's after the spacers; simplest to re-highlight by value match is overkill,
  // so just leave clean. Add a subtle note.
  sh.getRange(r + 1, 1).setValue('Snapshot of TODAY()-1. Updates with each morning run.')
    .setFontSize(9).setFontColor('#999');
}

// ----- shared helpers (dashboards) -----

const DATA = SHEET_NAME;  // 'daily_pnl'

/** Sum a single column of ga_daily over the same kind of date window. */
function gaSumBetween_(col, lowerExpr, upperExpr) {
  const N = GA_DAILY_MAX_ROWS;
  return `SUMPRODUCT((${GA_DAILY_TAB}!$A$2:$A$${N}>=${lowerExpr})*(${GA_DAILY_TAB}!$A$2:$A$${N}<${upperExpr})*${GA_DAILY_TAB}!${col}$2:${col}$${N})`;
}

/**
 * Column-letter <-> 1-based-index conversion. Earlier helpers used
 * String.fromCharCode(letter.charCodeAt(0) + i) for "the column N positions
 * to the right of this one," which silently breaks past column Z because it
 * only considers the first character. These helpers handle multi-letter
 * columns (AA, AB, AAA, etc.) correctly.
 */
function colLetterToIndex_(letters) {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result;
}
function colIndexToLetter_(index) {
  let result = '';
  while (index > 0) {
    const rem = (index - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    index = Math.floor((index - 1) / 26);
  }
  return result;
}

/**
 * Writes a 4-card "Conversion & Traffic" KPI row beneath the existing P&L
 * KPIs on a window-scoped dashboard tab. Sources from ga_daily.
 *
 * The four metrics are: Sessions, Conversion Rate, AOV (from GA, which differs
 * slightly from Shopify AOV because of attribution), and Revenue per User.
 * Each compares the current window to the prior window using the existing
 * writeKpiBlock_ delta logic.
 *
 * Conv rate and AOV are computed at window level (sum purchases / sum sessions,
 * not the average of daily rates) so a low-traffic day doesn't get the same
 * weight as a peak day.
 *
 * ga_daily columns (1-based):
 *   A=1 date, B=2 sessions, C=3 total_users, D=4 new_users,
 *   E=5 engagement_rate, F=6 bounce_rate, G=7 avg_session_duration_sec,
 *   H=8 view_items, I=9 add_to_carts, J=10 checkouts, K=11 purchases,
 *   L=12 revenue, ...
 */
function writeCROKpis_(sheet, labelRow, curLower, curUpper, priorLower, priorUpper) {
  // Section header above the cards.
  sheet.getRange(labelRow - 1, 1)
    .setValue('Conversion & Traffic')
    .setFontSize(11).setFontWeight('bold').setFontColor('#444');

  const sessions = (lo, hi) => gaSumBetween_('B', lo, hi);
  const totalUsers = (lo, hi) => gaSumBetween_('C', lo, hi);
  const purchases = (lo, hi) => gaSumBetween_('K', lo, hi);
  const revenue = (lo, hi) => gaSumBetween_('L', lo, hi);
  const convRate = (lo, hi) => `IFERROR(${purchases(lo, hi)}/${sessions(lo, hi)},0)`;
  const aov = (lo, hi) => `IFERROR(${revenue(lo, hi)}/${purchases(lo, hi)},0)`;
  const revPerUser = (lo, hi) => `IFERROR(${revenue(lo, hi)}/${totalUsers(lo, hi)},0)`;

  const kpis = [
    ['Sessions',
      `=${sessions(curLower, curUpper)}`,
      `=${sessions(priorLower, priorUpper)}`, '#,##0'],
    ['Conv Rate (GA)',
      `=${convRate(curLower, curUpper)}`,
      `=${convRate(priorLower, priorUpper)}`, '0.00%'],
    ['AOV (GA)',
      `=${aov(curLower, curUpper)}`,
      `=${aov(priorLower, priorUpper)}`, '$#,##0.00'],
    ['Revenue / User',
      `=${revPerUser(curLower, curUpper)}`,
      `=${revPerUser(priorLower, priorUpper)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sheet, labelRow, kpis);
}

/**
 * Writes a hidden helper area for the conversion-rate-by-device chart. The
 * chart needs three series — overall, mobile, desktop — all aligned on the
 * same date column. We use FILTER to spill the in-window dates and overall
 * rate from ga_daily, then ARRAYFORMULA+SUMIFS to look up the per-device rate
 * for each spilled date from ga_by_device.
 *
 * Helper layout (4 columns starting at helperColLetter):
 *   col+0: date (spilled from ga_daily by window)
 *   col+1: overall conv rate (spilled from ga_daily by window)
 *   col+2: mobile conv rate (looked up per row)
 *   col+3: desktop conv rate (looked up per row)
 *
 * If ga_daily is empty (first run before any GA pull), the FILTER returns an
 * empty string and the chart silently shows nothing, which is what we want —
 * better than a #REF! error in the user's face.
 */
function writeGAConvRateHelper_(sheet, helperColLetter, lowerExpr, upperExpr, depth) {
  const startIdx = colLetterToIndex_(helperColLetter);
  const a = colIndexToLetter_(startIdx);
  const b = colIndexToLetter_(startIdx + 1);
  const c = colIndexToLetter_(startIdx + 2);
  const d = colIndexToLetter_(startIdx + 3);
  // Depth is the window size (plus slack), not a flat 400. The two ARRAYFORMULAs
  // below each evaluate one SUMIFS per row, so this bound is multiplied by two
  // on every recalc of every dashboard tab.
  const H = depth;

  // FILTER ga_daily(date, conversion_rate) where date in window.
  // ga_daily columns: A=date (1), Q=conversion_rate (17).
  const filterFormula =
    `=IFERROR(FILTER({${GA_DAILY_TAB}!A2:A$${GA_DAILY_MAX_ROWS},${GA_DAILY_TAB}!Q2:Q$${GA_DAILY_MAX_ROWS}},` +
    `(${GA_DAILY_TAB}!A2:A$${GA_DAILY_MAX_ROWS}>=${lowerExpr})*(${GA_DAILY_TAB}!A2:A$${GA_DAILY_MAX_ROWS}<${upperExpr})),"")`;
  sheet.getRange(`${a}2`).setFormula(filterFormula);

  sheet.getRange(`${a}1`).setValue('ga_date');
  sheet.getRange(`${b}1`).setValue('overall_cv');
  sheet.getRange(`${c}1`).setValue('mobile_cv');
  sheet.getRange(`${d}1`).setValue('desktop_cv');

  // Force the date column to render as date strings so the chart axis reads
  // them correctly (FILTER may pass them through as dates already, but we
  // normalize for safety).
  sheet.getRange(`${a}2:${a}${H}`).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(`${b}2:${d}${H}`).setNumberFormat('0.00%');

  // Per-row mobile/desktop conv rate via ARRAYFORMULA + SUMIFS. ga_by_device
  // columns: A=date, B=device, Q=conversion_rate (17 = same as ga_daily).
  const mobileFormula =
    `=ARRAYFORMULA(IF($${a}$2:$${a}$${H}="","",` +
    `IFERROR(SUMIFS(${GA_DEVICE_TAB}!$Q$2:$Q$${GA_DEVICE_MAX_ROWS},${GA_DEVICE_TAB}!$A$2:$A$${GA_DEVICE_MAX_ROWS},$${a}$2:$${a}$${H},${GA_DEVICE_TAB}!$B$2:$B$${GA_DEVICE_MAX_ROWS},"mobile"),0)))`;
  const desktopFormula =
    `=ARRAYFORMULA(IF($${a}$2:$${a}$${H}="","",` +
    `IFERROR(SUMIFS(${GA_DEVICE_TAB}!$Q$2:$Q$${GA_DEVICE_MAX_ROWS},${GA_DEVICE_TAB}!$A$2:$A$${GA_DEVICE_MAX_ROWS},$${a}$2:$${a}$${H},${GA_DEVICE_TAB}!$B$2:$B$${GA_DEVICE_MAX_ROWS},"desktop"),0)))`;

  sheet.getRange(`${c}2`).setFormula(mobileFormula);
  sheet.getRange(`${d}2`).setFormula(desktopFormula);
}

/**
 * Inserts the conversion-rate-over-time chart on `sheet`, pointing at the
 * helper area from writeGAConvRateHelper_. Three lines (overall + mobile +
 * desktop) is the CRO-skill-prescribed view — watching mobile diverge from
 * desktop is how you catch a mobile-specific regression before it shows up
 * in revenue.
 */
function insertGAConvRateChart_(sheet, label, helperColLetter, position, depth) {
  const startIdx = colLetterToIndex_(helperColLetter);
  const a = colIndexToLetter_(startIdx);
  const b = colIndexToLetter_(startIdx + 1);
  const c = colIndexToLetter_(startIdx + 2);
  const d = colIndexToLetter_(startIdx + 3);
  // Must match the depth its helper area was written with.
  const H = depth;
  const r = (col) => sheet.getRange(`${col}2:${col}${H}`);

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(r(a)).addRange(r(b)).addRange(r(c)).addRange(r(d))
    .setPosition(position.row, position.col, 0, 0)
    .setOption('title', 'Conversion Rate by Device (' + label + ')')
    .setOption('width', 1050).setOption('height', 300)
    .setOption('colors', ['#1a1a1a', '#dc3545', '#0969da'])
    .setOption('series', {
      0: { labelInLegend: 'Overall', lineWidth: 3 },
      1: { labelInLegend: 'Mobile', lineWidth: 2 },
      2: { labelInLegend: 'Desktop', lineWidth: 2 },
    })
    .setOption('vAxis', { format: '0.00%' })
    .setOption('interpolateNulls', true)
    .build();
  sheet.insertChart(chart);
}

/**
 * Writes a hidden helper for the YTD source-mix chart: 12 monthly rows with
 * sessions broken out into 5 marketing-channel categories plus Other. We use
 * sessionMedium as the categorizer (organic / cpc / email / referral / (none))
 * rather than dynamic top-N source picking, because mediums are a small stable
 * set and don't require querying the data at build time to decide what to plot.
 *
 * Helper layout (7 columns starting at helperColLetter):
 *   col+0: month label
 *   col+1: organic
 *   col+2: paid (cpc)
 *   col+3: email
 *   col+4: referral
 *   col+5: direct (sessionMedium = "(none)")
 *   col+6: other (sessions minus the categorized total)
 *
 * Each cell uses SUMIFS against ga_traffic_sources scoped to that month.
 * ga_traffic_sources columns: A=date, B=source, C=medium, D=sessions.
 */
function writeYTDSourceMixHelper_(sheet, helperColLetter, headerRow) {
  const startIdx = colLetterToIndex_(helperColLetter);
  const cols = [];
  for (let i = 0; i < 7; i++) {
    cols.push(colIndexToLetter_(startIdx + i));
  }
  const [colMonth, colOrganic, colPaid, colEmail, colReferral, colDirect, colOther] = cols;

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const year = new Date().getFullYear();

  // SUMIFS by medium for a given month. Date columns in ga_traffic_sources may
  // be stored as either dates or yyyy-mm-dd strings; using DATE() comparisons
  // works for both because Sheets coerces strings to dates when compared.
  const sumByMedium = (m, medium) => {
    const monthStart = `DATE(${year},${m},1)`;
    const monthEnd = `EDATE(DATE(${year},${m},1),1)`;
    const N = GA_TRAFFIC_MAX_ROWS;
    return `IFERROR(SUMIFS(${GA_TRAFFIC_TAB}!D$2:D$${N},` +
      `${GA_TRAFFIC_TAB}!A$2:A$${N},">="&${monthStart},` +
      `${GA_TRAFFIC_TAB}!A$2:A$${N},"<"&${monthEnd},` +
      `${GA_TRAFFIC_TAB}!C$2:C$${N},"${medium}"),0)`;
  };
  // Total sessions for a month (any medium) — used to compute "Other".
  const sumAll = (m) => {
    const monthStart = `DATE(${year},${m},1)`;
    const monthEnd = `EDATE(DATE(${year},${m},1),1)`;
    const N = GA_TRAFFIC_MAX_ROWS;
    return `IFERROR(SUMIFS(${GA_TRAFFIC_TAB}!D$2:D$${N},` +
      `${GA_TRAFFIC_TAB}!A$2:A$${N},">="&${monthStart},` +
      `${GA_TRAFFIC_TAB}!A$2:A$${N},"<"&${monthEnd}),0)`;
  };

  // Build the whole 13x7 block (header + 12 months) in memory and write it with
  // ONE setValues. The previous version issued a separate getRange/setValue or
  // setFormula per cell: 7 header writes plus 84 body writes, 91 Sheets round
  // trips, every time this tab was rebuilt. setValues enters any string starting
  // with "=" as a real formula, so the formula cells come along in the same call.
  const block = [
    ['Month', 'Organic', 'Paid', 'Email', 'Referral', 'Direct', 'Other'],
  ];
  for (let m = 1; m <= 12; m++) {
    const row = headerRow + m;
    block.push([
      monthNames[m - 1],
      `=${sumByMedium(m, 'organic')}`,
      `=${sumByMedium(m, 'cpc')}`,
      `=${sumByMedium(m, 'email')}`,
      `=${sumByMedium(m, 'referral')}`,
      `=${sumByMedium(m, '(none)')}`,
      // Other = total - (the five categorized)
      `=MAX(0,${sumAll(m)}-${colOrganic}${row}-${colPaid}${row}-` +
      `${colEmail}${row}-${colReferral}${row}-${colDirect}${row})`,
    ]);
  }
  sheet.getRange(headerRow, startIdx, block.length, 7).setValues(block);

  // Apply integer formatting to the numeric cells.
  sheet.getRange(`${colOrganic}${headerRow + 1}:${colOther}${headerRow + 12}`)
    .setNumberFormat('#,##0');
}

/**
 * Inserts the YTD source-mix stacked area chart, pointing at the helper area
 * from writeYTDSourceMixHelper_.
 */
function insertYTDSourceMixChart_(sheet, helperColLetter, headerRow, position) {
  const startIdx = colLetterToIndex_(helperColLetter);
  const cols = [];
  for (let i = 0; i < 7; i++) {
    cols.push(colIndexToLetter_(startIdx + i));
  }
  const start = headerRow + 1;
  const end = headerRow + 12;

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.AREA)
    .addRange(sheet.getRange(`${cols[0]}${start}:${cols[0]}${end}`))  // month
    .addRange(sheet.getRange(`${cols[1]}${start}:${cols[6]}${end}`))  // 6 series
    .setPosition(position.row, position.col, 0, 0)
    .setOption('title', 'YTD Sessions by Channel')
    .setOption('width', 760).setOption('height', 320)
    .setOption('isStacked', true)
    .setOption('colors', ['#57a773', '#dc3545', '#8250df', '#0969da', '#999999', '#cccccc'])
    .setOption('series', {
      0: { labelInLegend: 'Organic' },
      1: { labelInLegend: 'Paid' },
      2: { labelInLegend: 'Email' },
      3: { labelInLegend: 'Referral' },
      4: { labelInLegend: 'Direct' },
      5: { labelInLegend: 'Other' },
    })
    .build();
  sheet.insertChart(chart);
}

/** Sum a single column over rows whose date is between two date-formulas (inclusive lower, exclusive upper). */
function sumBetween_(col, lowerExpr, upperExpr) {
  const N = PNL_MAX_ROWS;
  return `SUMPRODUCT((${DATA}!$A$2:$A$${N}>=${lowerExpr})*(${DATA}!$A$2:$A$${N}<${upperExpr})*${DATA}!${col}$2:${col}$${N})`;
}
/** Sum of all five cost columns over the same window: F printify, G gelato, H meta, I fees, L google. */
function sumCostsBetween_(lowerExpr, upperExpr) {
  const N = PNL_MAX_ROWS;
  return `SUMPRODUCT((${DATA}!$A$2:$A$${N}>=${lowerExpr})*(${DATA}!$A$2:$A$${N}<${upperExpr})*(${DATA}!F$2:F$${N}+${DATA}!G$2:G$${N}+${DATA}!H$2:H$${N}+${DATA}!I$2:I$${N}+${DATA}!L$2:L$${N}))`;
}
/** Total ad spend (Meta H + Google L) over the window. */
function adsBetween_(lowerExpr, upperExpr) {
  const N = PNL_MAX_ROWS;
  return `SUMPRODUCT((${DATA}!$A$2:$A$${N}>=${lowerExpr})*(${DATA}!$A$2:$A$${N}<${upperExpr})*(${DATA}!H$2:H$${N}+${DATA}!L$2:L$${N}))`;
}
/** MER (blended ROAS) = sum(net revenue) / sum(Meta + Google spend) over the window. */
function merBetween_(lowerExpr, upperExpr) {
  return `IFERROR(${sumBetween_('D', lowerExpr, upperExpr)}/${adsBetween_(lowerExpr, upperExpr)},0)`;
}
/** Contribution margin per order = sum(profit) / sum(orders) over the window. */
function profitPerOrderBetween_(lowerExpr, upperExpr) {
  return `IFERROR(${sumBetween_('J', lowerExpr, upperExpr)}/${sumBetween_('E', lowerExpr, upperExpr)},0)`;
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
  const sh = resetDashboardSheet_(ss, 'dashboard_ytd', 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 9, 120);
  sh.setColumnWidth(1, 150);

  // Default new sheets have 26 columns (A..Z). The YTD tab uses helper areas
  // up through column AG (33), so expand the grid before we try to write or
  // hide anything past Z. Skip if a previous run already expanded.
  const REQUIRED_COLS = 33;
  if (sh.getMaxColumns() < REQUIRED_COLS) {
    sh.insertColumnsAfter(sh.getMaxColumns(), REQUIRED_COLS - sh.getMaxColumns());
  }

  sh.getRange('A1').setValue('Year to Date + Forecast').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('YTD actuals (Jan 1–today) vs. the same span of 2025; full-year forecast scenarios below')
    .setFontSize(10).setFontColor('#666');
  // A3 = data-freshness stamp. Set early so it's not overwritten by later writes.
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

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
      `=${sumBetween_('J', cy, cyUp)}`,
      `=${sumBetween_('J', ly, lyUp)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('J', cy, cyUp)}/${sumBetween_('D', cy, cyUp)},0)`,
      `=IFERROR(${sumBetween_('J', ly, lyUp)}/${sumBetween_('D', ly, lyUp)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(cy, cyUp)}`,
      `=${merBetween_(ly, lyUp)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(cy, cyUp)}`,
      `=${profitPerOrderBetween_(ly, lyUp)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);

  // ---- CRO KPI cards (Sessions, Conv Rate, AOV, Rev/User) ----
  // Same pattern as the other aggregate tabs. Sourced from ga_daily.
  writeCROKpis_(sh, 14, cy, cyUp, ly, lyUp);

  // ---- Scenario forecast helper table (hidden, drives the line graph) ----
  // Helper columns: L month, M cumulative ACTUAL, N +5% cum, O +10% cum, P +20% cum.
  // hRow stays at 14 — these cols are hidden so the visual position doesn't matter;
  // only the cell references from the chart do.
  const hRow = 14;
  sh.getRange(hRow, 12, 1, 5)
    .setValues([['Month', 'Actual', '+5%', '+10%', '+20%']]);

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Build the 12x5 scenario table in memory and write it with ONE setValues,
  // then apply the number format to the whole numeric block in one call. The
  // previous version did a getRange plus setFormula plus setNumberFormat per
  // cell: roughly 180 Sheets round trips for this table alone, on the tab that
  // buildDashboard builds FIRST and therefore the one that got killed when the
  // execution ran out of time. That is why dashboard_ytd was left empty.
  const forecast = [];
  for (let m = 1; m <= 12; m++) {
    const row = hRow + m;
    const s26 = `DATE(2026,${m},1)`;
    const e26 = `EDATE(DATE(2026,${m},1),1)`;
    const s25 = `DATE(2025,${m},1)`;
    const e25 = `EDATE(DATE(2025,${m},1),1)`;
    const started = `(TODAY()>=${s26})`;

    const act = sumBetween_('D', s26, e26);   // 2026 month revenue
    const ly25 = sumBetween_('D', s25, e25);  // 2025 month revenue

    // Cumulative ACTUAL (col M): running total while the month has started,
    // then NA() so the solid line ends at the present instead of dropping.
    const prevM = m === 1 ? '0' : `M${row - 1}`;
    // Scenario cumulative (cols N,O,P): actual if the month started, else the
    // 2025 month lifted by the scenario %. Added to the prior cumulative.
    const prevN = m === 1 ? '0' : `N${row - 1}`;
    const prevO = m === 1 ? '0' : `O${row - 1}`;
    const prevP = m === 1 ? '0' : `P${row - 1}`;

    forecast.push([
      monthNames[m - 1],
      `=IF(${started},${prevM}+${act},NA())`,
      `=${prevN}+IF(${started},${act},${ly25}*1.05)`,
      `=${prevO}+IF(${started},${act},${ly25}*1.10)`,
      `=${prevP}+IF(${started},${act},${ly25}*1.20)`,
    ]);
  }
  sh.getRange(hRow + 1, 12, forecast.length, 5).setValues(forecast);
  sh.getRange(hRow + 1, 13, forecast.length, 4).setNumberFormat('$#,##0');

  // GA helper areas. Conv-rate helper in V..Y (date + 3 conv-rate series),
  // source-mix helper in AA..AG (12 monthly rows starting at row 28).
  writeGAConvRateHelper_(sh, 'V', cy, cyUp, DEPTH_YTD);
  writeYTDSourceMixHelper_(sh, 'AA', 28);

  // Hide all helper ranges so the tab stays clean.
  sh.hideColumns(12, 5);   // L..P (forecast helper)
  sh.hideColumns(22, 4);   // V..Y (GA conv-rate helper)
  sh.hideColumns(27, 7);   // AA..AG (YTD source-mix helper)

  // ---- Cumulative revenue chart (shifted from row 14 to row 22 to make
  // room for the CRO KPI block above) ----
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(sh.getRange(`L${hRow + 1}:L${hRow + 12}`))
    .addRange(sh.getRange(`M${hRow + 1}:M${hRow + 12}`))
    .addRange(sh.getRange(`N${hRow + 1}:N${hRow + 12}`))
    .addRange(sh.getRange(`O${hRow + 1}:O${hRow + 12}`))
    .addRange(sh.getRange(`P${hRow + 1}:P${hRow + 12}`))
    .setPosition(22, 1, 0, 0)
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

  // ---- Conversion rate by device chart (full width below cumulative chart) ----
  insertGAConvRateChart_(sh, 'YTD', 'V', { row: 46, col: 1 }, DEPTH_YTD);

  // ---- YTD traffic source mix (stacked area, full width) ----
  insertYTDSourceMixChart_(sh, 'AA', 28, { row: 64, col: 1 });

  sh.getRange(84, 1).setValue(
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
 * formula, and returns the column letters used. Charts then point here so they
 * only show the relevant window.
 *
 * Helper layout (one FILTER spilling into 7 columns): date, net, profit,
 * printify, gelato, meta, fees.
 *
 * Google spend lives in its OWN filter in column Z rather than being added to the
 * one above. Adding it there would spill an 8th column into U, which is where the
 * 7-day profit average lives, and V..Y is the GA conversion helper, so there is no
 * free column to shift into. A second FILTER with the identical condition over the
 * same rows returns the same rows in the same order, so Z lines up with N row for row.
 */
function writeHelperFilter_(sheet, helperColLetter, lowerExpr, upperExpr, depth) {
  // FILTER daily_pnl columns A,D,J,F,G,H,I where date in window.
  const formula =
    `=IFERROR(FILTER({${DATA}!A2:A$${PNL_MAX_ROWS},${DATA}!D2:D$${PNL_MAX_ROWS},${DATA}!J2:J$${PNL_MAX_ROWS},${DATA}!F2:F$${PNL_MAX_ROWS},${DATA}!G2:G$${PNL_MAX_ROWS},${DATA}!H2:H$${PNL_MAX_ROWS},${DATA}!I2:I$${PNL_MAX_ROWS}},` +
    `(${DATA}!A2:A$${PNL_MAX_ROWS}>=${lowerExpr})*(${DATA}!A2:A$${PNL_MAX_ROWS}<${upperExpr})),"")`;
  sheet.getRange(`${helperColLetter}2`).setFormula(formula);
  // Header row for clarity (optional, charts use ranges not headers).
  sheet.getRange(`${helperColLetter}1`).setValue('date');
  // Force the spilled date column to render as dates (not serial numbers) so
  // chart x-axes read correctly.
  sheet.getRange(`${helperColLetter}2:${helperColLetter}${depth}`).setNumberFormat('yyyy-mm-dd');

  // 7-day rolling average of profit, in column U (one past the 7 spilled cols
  // N..T). For each helper row, average the trailing 7 profit values (col P).
  // Only emit a value where there's a date present, else blank. Batched into a
  // single setFormulas call rather than one write per row.
  //
  // Depth is the window size, not a flat 400. These formulas re-evaluate on
  // every recalc, so writing 399 of them on a tab that shows 7 days was pure
  // overhead paid on every single sheet write in the whole project.
  sheet.getRange('U1').setValue('profit_7dma');
  const rolling = [];
  for (let row = 2; row <= depth; row++) {
    const from = Math.max(2, row - 6);
    rolling.push([`=IF($N${row}="","",AVERAGE($P${from}:$P${row}))`]);
  }
  sheet.getRange(2, 21, rolling.length, 1).setFormulas(rolling);  // col 21 = U
  sheet.getRange(`U2:U${depth}`).setNumberFormat('$#,##0.00');

  // Google spend for the same window, in column Z (see the note above).
  sheet.getRange('Z1').setValue('google');
  sheet.getRange('Z2').setFormula(
    `=IFERROR(FILTER(${DATA}!L2:L$${PNL_MAX_ROWS},` +
    `(${DATA}!A2:A$${PNL_MAX_ROWS}>=${lowerExpr})*(${DATA}!A2:A$${PNL_MAX_ROWS}<${upperExpr})),"")`);
  sheet.getRange(`Z2:Z${depth}`).setNumberFormat('$#,##0.00');
}

function buildDashboardMTD_(ss, data) {
  const sh = resetDashboardSheet_(ss, 'dashboard_mtd', 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 8, 130);

  sh.getRange('A1').setValue('Month to Date').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('vs. same days of last month')
    .setFontSize(10).setFontColor('#666');
  // A3 = data-freshness stamp.
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  // Window expressions.
  // Current MTD: from first of this month (inclusive) to tomorrow (exclusive).
  const curLower = 'DATE(YEAR(TODAY()),MONTH(TODAY()),1)';
  const curUpper = '(TODAY()+1)';
  // Prior period: same number of days, last month. first of last month (incl)
  // to (first of last month + days elapsed this month) exclusive.
  const priorLower = 'EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-1)';
  const priorUpper = '(EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-1)+DAY(TODAY()))';

  const kpis = [
    ['Revenue (net)',
      `=${sumBetween_('D', curLower, curUpper)}`,
      `=${sumBetween_('D', priorLower, priorUpper)}`, '$#,##0'],
    ['Total Costs',
      `=${sumCostsBetween_(curLower, curUpper)}`,
      `=${sumCostsBetween_(priorLower, priorUpper)}`, '$#,##0'],
    ['Profit',
      `=${sumBetween_('J', curLower, curUpper)}`,
      `=${sumBetween_('J', priorLower, priorUpper)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('J', curLower, curUpper)}/${sumBetween_('D', curLower, curUpper)},0)`,
      `=IFERROR(${sumBetween_('J', priorLower, priorUpper)}/${sumBetween_('D', priorLower, priorUpper)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(curLower, curUpper)}`,
      `=${merBetween_(priorLower, priorUpper)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(curLower, curUpper)}`,
      `=${profitPerOrderBetween_(priorLower, priorUpper)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);

  // CRO KPI cards beneath the P&L row.
  writeCROKpis_(sh, 14, curLower, curUpper, priorLower, priorUpper);

  // Hidden helper area for scoped charts (columns N onward).
  writeHelperFilter_(sh, 'N', curLower, curUpper, DEPTH_MTD);
  writeGAConvRateHelper_(sh, 'V', curLower, curUpper, DEPTH_MTD);
  sh.hideColumns(14, 11);  // hide N..X
  sh.hideColumns(25, 2);   // hide Y..Z (rest of the GA helper, and the Google helper)

  insertScopedCharts_(sh, 'this month', DEPTH_MTD);
  insertGAConvRateChart_(sh, 'this month', 'V', { row: 42, col: 1 }, DEPTH_MTD);
}

function buildDashboard30d_(ss, data) {
  const sh = resetDashboardSheet_(ss, 'dashboard_30d', 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 8, 130);

  sh.getRange('A1').setValue('Last 30 Days').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('vs. the prior 30 days')
    .setFontSize(10).setFontColor('#666');
  // A3 = data-freshness stamp.
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  // Current 30d: [today-29, tomorrow). Prior 30d: [today-59, today-29).
  const curLower = '(TODAY()-29)';
  const curUpper = '(TODAY()+1)';
  const priorLower = '(TODAY()-59)';
  const priorUpper = '(TODAY()-29)';

  const kpis = [
    ['Revenue (net)',
      `=${sumBetween_('D', curLower, curUpper)}`,
      `=${sumBetween_('D', priorLower, priorUpper)}`, '$#,##0'],
    ['Total Costs',
      `=${sumCostsBetween_(curLower, curUpper)}`,
      `=${sumCostsBetween_(priorLower, priorUpper)}`, '$#,##0'],
    ['Profit',
      `=${sumBetween_('J', curLower, curUpper)}`,
      `=${sumBetween_('J', priorLower, priorUpper)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('J', curLower, curUpper)}/${sumBetween_('D', curLower, curUpper)},0)`,
      `=IFERROR(${sumBetween_('J', priorLower, priorUpper)}/${sumBetween_('D', priorLower, priorUpper)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(curLower, curUpper)}`,
      `=${merBetween_(priorLower, priorUpper)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(curLower, curUpper)}`,
      `=${profitPerOrderBetween_(priorLower, priorUpper)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);

  // CRO KPI cards beneath the P&L row.
  writeCROKpis_(sh, 14, curLower, curUpper, priorLower, priorUpper);

  writeHelperFilter_(sh, 'N', curLower, curUpper, DEPTH_30D);
  writeGAConvRateHelper_(sh, 'V', curLower, curUpper, DEPTH_30D);
  sh.hideColumns(14, 11);  // hide N..X
  sh.hideColumns(25, 2);   // hide Y..Z (rest of the GA helper, and the Google helper)

  insertScopedCharts_(sh, 'last 30 days', DEPTH_30D);
  insertGAConvRateChart_(sh, 'last 30 days', 'V', { row: 42, col: 1 }, DEPTH_30D);
}

function buildDashboard7d_(ss, data) {
  const sh = resetDashboardSheet_(ss, 'dashboard_7d', 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidths(1, 8, 130);

  sh.getRange('A1').setValue('Last 7 Days').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('vs. the prior 7 days')
    .setFontSize(10).setFontColor('#666');
  // A3 = data-freshness stamp.
  stampLastUpdated_(sh, 'A3', LAST_RUN_DAILY_KEY, ss.getSpreadsheetTimeZone());

  // Current 7d: [today-6, tomorrow). Prior 7d: [today-13, today-6).
  const curLower = '(TODAY()-6)';
  const curUpper = '(TODAY()+1)';
  const priorLower = '(TODAY()-13)';
  const priorUpper = '(TODAY()-6)';

  const kpis = [
    ['Revenue (net)',
      `=${sumBetween_('D', curLower, curUpper)}`,
      `=${sumBetween_('D', priorLower, priorUpper)}`, '$#,##0'],
    ['Total Costs',
      `=${sumCostsBetween_(curLower, curUpper)}`,
      `=${sumCostsBetween_(priorLower, priorUpper)}`, '$#,##0'],
    ['Profit',
      `=${sumBetween_('J', curLower, curUpper)}`,
      `=${sumBetween_('J', priorLower, priorUpper)}`, '$#,##0'],
    ['Margin %',
      `=IFERROR(${sumBetween_('J', curLower, curUpper)}/${sumBetween_('D', curLower, curUpper)},0)`,
      `=IFERROR(${sumBetween_('J', priorLower, priorUpper)}/${sumBetween_('D', priorLower, priorUpper)},0)`, '0.0%'],
    ['MER (rev/ad$)',
      `=${merBetween_(curLower, curUpper)}`,
      `=${merBetween_(priorLower, priorUpper)}`, '0.00"x"'],
    ['Profit / Order',
      `=${profitPerOrderBetween_(curLower, curUpper)}`,
      `=${profitPerOrderBetween_(priorLower, priorUpper)}`, '$#,##0.00'],
  ];
  writeKpiBlock_(sh, 4, kpis);

  // CRO KPI cards beneath the P&L row, sourced from ga_daily.
  writeCROKpis_(sh, 14, curLower, curUpper, priorLower, priorUpper);

  writeHelperFilter_(sh, 'N', curLower, curUpper, DEPTH_7D);
  // GA conv-rate-by-device helper for the new chart. Lives in cols V..Y so it
  // doesn't collide with the existing N..U helpers.
  writeGAConvRateHelper_(sh, 'V', curLower, curUpper, DEPTH_7D);
  sh.hideColumns(14, 11);  // hide N..X (P&L helpers + GA conv helpers)
  sh.hideColumns(25, 2);   // hide Y..Z (rest of the GA helper, and the Google helper)

  insertScopedCharts_(sh, 'last 7 days', DEPTH_7D);
  // GA conv-rate chart, full width below the P&L charts.
  insertGAConvRateChart_(sh, 'last 7 days', 'V', { row: 42, col: 1 }, DEPTH_7D);
}

/**
 * Inserts the three charts on `sheet`, pointing at the hidden helper area
 * (columns N:T, plus Z) so they show only the scoped window. Helper layout:
 *   N=date, O=net, P=profit, Q=printify, R=gelato, S=meta, T=fees, U=profit_7dma,
 *   Z=google
 * Depth must match the depth the helper area was written with.
 */
function insertScopedCharts_(sheet, label, depth) {
  const H = depth;  // helper depth, sized to this tab's window
  const r = (a) => sheet.getRange(`${a}2:${a}${H}`);

  // Chart row positions:
  //   Row 22: profit chart (col 1) + revenue chart (col 6) — was row 12,
  //           shifted to make room for the new CRO KPI block at rows 12-16.
  //   Row 42: conv-rate chart (col 1, full width) — added by insertGAConvRateChart_.
  //   Row 60: cost chart (col 1, full width) — was row 26.

  const profitChart = sheet.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(r('N')).addRange(r('P')).addRange(r('U'))
    .setPosition(22, 1, 0, 0)
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
    .addRange(r('N')).addRange(r('O')).addRange(r('P'))
    .setPosition(22, 6, 0, 0)
    .setOption('title', 'Revenue vs Profit (' + label + ')')
    .setOption('width', 520).setOption('height', 260)
    .setOption('colors', ['#0969da', '#1a7f37'])
    .setOption('series', { 0: { labelInLegend: 'Net Revenue' }, 1: { labelInLegend: 'Profit' } })
    .build();
  sheet.insertChart(revChart);

  const costChart = sheet.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(r('N')).addRange(r('Q')).addRange(r('R')).addRange(r('S')).addRange(r('Z')).addRange(r('T'))
    .setPosition(60, 1, 0, 0)
    .setOption('title', 'Cost Breakdown by Day (' + label + ')')
    .setOption('isStacked', true)
    .setOption('width', 1050).setOption('height', 300)
    .setOption('colors', ['#cf222e', '#bf8700', '#8250df', '#0969da', '#999999'])
    .setOption('series', {
      0: { labelInLegend: 'Printify' },
      1: { labelInLegend: 'Gelato' },
      2: { labelInLegend: 'Meta' },
      3: { labelInLegend: 'Google' },
      4: { labelInLegend: 'Shopify Fees' },
    })
    .build();
  sheet.insertChart(costChart);
}

function runDaily() {
  return withLock_('runDaily', runDailyUnlocked_);
}

function runDailyUnlocked_() {
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
  //
  // This full rebuild lives on the ONCE-A-DAY runDaily path, where its cost (six
  // tabs torn down and recreated, ~15 charts re-inserted) is fine. runToday
  // deliberately does NOT call this — see the note there.
  try {
    timed_('buildDashboard', buildDashboard);
  } catch (e) {
    Logger.log('Dashboard refresh skipped: ' + e.message);
  }
}

/**
 * Midday/intraday pull: re-fetches ONLY today's data and rewrites today's row.
 * Use as a separate time-based trigger (e.g. noon, 3pm) for an in-progress
 * read on the day so far. The morning runDaily trigger will overwrite this
 * row with the final, complete numbers — so today's row is allowed to be a
 * partial snapshot during the day.
 *
 * Cheaper than runDaily (1 day vs. 30 days of API calls), so safe to run
 * multiple times a day if you want hourly refreshes.
 *
 * Note: figures will read LOW until the day ends — a noon snapshot only
 * captures roughly half a day of revenue and ad spend. That's expected;
 * use it for direction, not for reconciliation.
 */
function runToday() {
  return withLock_('runToday', runTodayUnlocked_);
}

function runTodayUnlocked_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const now = new Date();
  // Window is [start of today, start of tomorrow) in the sheet timezone, so
  // we pull exactly the calendar day "today" — matching how the rest of the
  // script buckets orders.
  const startFloor = startOfDayInTz(now, tz);
  const endFloor = startOfDayInTz(new Date(now.getTime() + 24 * 60 * 60 * 1000), tz);
  processWindow(startFloor, endFloor, tz);

  // Record when this intraday run pulled data. Set BEFORE refreshing the today
  // tab so its stamp reads the just-updated value.
  PropertiesService.getScriptProperties().setProperty(LAST_RUN_TODAY_KEY, new Date().toISOString());

  // Do NOT rebuild the dashboards here. Every dashboard tab is built from live
  // formulas (VLOOKUP / SUMPRODUCT / FILTER keyed on TODAY()), so the daily_pnl
  // row we just wrote for today flows into all of them automatically on the next
  // recalc. buildDashboard() tears down and recreates six tabs and re-inserts
  // ~15 charts, which is by far the slowest thing in this project. Running it on
  // every intraday runToday is what pushed execution past the time limit and made
  // this trigger fail. The only thing on the "today" tab that ISN'T a live formula
  // is its freshness-stamp cell, so we refresh just that in place.
  try {
    timed_('refreshTodayStamp_', refreshTodayStamp_);
  } catch (e) {
    Logger.log('Today stamp refresh skipped: ' + e.message);
  }
}

/**
 * Lightweight in-place refresh of only the "today" tab's freshness stamp (cell
 * A3), used by runToday instead of a full buildDashboard(). Everything else on
 * every dashboard tab is a live formula, so the data updates itself on recalc;
 * only this stamp is a static string written at build time and needs a nudge.
 *
 * If the "today" tab doesn't exist yet (e.g. runToday fired before the first
 * runDaily ever built the dashboards), this quietly does nothing — the next
 * runDaily will create it. That's why it's wrapped in try/catch at the call
 * site: a missing tab must never fail the data pull.
 */
function refreshTodayStamp_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('today');
  if (!sh) return;
  stampLastUpdated_(sh, 'A3', LAST_RUN_TODAY_KEY, ss.getSpreadsheetTimeZone());
}

/**
 * GA4 daily pull on its own schedule — kept separate from runDaily so it can
 * run later in the day, after GA4's event-attribution lag has settled.
 *
 * Why a separate trigger? GA4 events trickle in for 24–48 hours after they
 * happen (especially sessions started late in the prior day). Running this
 * at noon or end-of-day captures more of yesterday's late-arriving events
 * than the early-morning runDaily would.
 *
 * Same trailing-30-day window as runDaily, so each run rewrites the last 30
 * days of GA tabs in place — overwriting earlier, less-settled snapshots with
 * the now-more-complete data.
 *
 * No buildDashboard call: none of the current dashboards reference GA data,
 * so rebuilding them would be wasted work. If a CRO dashboard tab gets added
 * later, add a buildDashboard call here.
 */
function runGADaily() {
  return withLock_('runGADaily', runGADailyUnlocked_);
}

function runGADailyUnlocked_() {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const today = new Date();
  const start = new Date(today.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const startFloor = startOfDayInTz(start, tz);
  const endFloor = startOfDayInTz(new Date(today.getTime() + 24 * 60 * 60 * 1000), tz);

  // No outer try/catch here: if GA fails we WANT this run to fail loudly in
  // the Executions log, because nothing else depends on it. (Inside runDaily
  // we caught errors to protect the rest of the pipeline; here there's no
  // other pipeline to protect.)
  runGA4Pull_(startFloor, endFloor, tz);
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
  return withLock_('backfillAllHistory', backfillAllHistoryUnlocked_);
}

function backfillAllHistoryUnlocked_() {
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

function testShopifyAuth() {
  CacheService.getScriptCache().remove('shopify_access_token');
  const token = getShopifyAccessToken();
  Logger.log('Got Shopify token (length ' + token.length + '). First 8 chars: ' + token.substring(0, 8));
}

// ---------- Core: process a date window ----------

function processWindow(start, end, tz) {
  // Each stage is timed so the Executions log names the slow one directly.
  const shopify = timed_('fetchShopify', function () { return fetchShopifyByDay(start, end, tz); });
  const printify = timed_('fetchPrintify', function () { return fetchPrintifyByDay(start, end, tz); });
  const gelato = timed_('fetchGelato', function () { return fetchGelatoByDay(start, end, tz); });
  const meta = timed_('fetchMeta', function () { return fetchMetaDaily_(start, end, tz); });

  const days = {};
  for (const d of allDatesBetween(start, end, tz)) {
    days[d] = blankDay(d);
  }
  for (const [d, v] of Object.entries(shopify)) Object.assign(days[d] || (days[d] = blankDay(d)), v);
  for (const [d, v] of Object.entries(printify)) (days[d] || (days[d] = blankDay(d))).printify_cost = v;
  for (const [d, v] of Object.entries(gelato)) (days[d] || (days[d] = blankDay(d))).gelato_cost = v;
  for (const [d, v] of Object.entries(meta.spend)) (days[d] || (days[d] = blankDay(d))).meta_spend = v;
  for (const [d, v] of Object.entries(meta.purchases)) (days[d] || (days[d] = blankDay(d))).meta_purchases = v;
  for (const [d, v] of Object.entries(meta.value)) (days[d] || (days[d] = blankDay(d))).meta_purchase_value = v;

  const rows = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));
  timed_('writeRows(' + rows.length + ' rows)', function () { writeRows(rows); });

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

// ---------- Gelato ----------

function fetchGelatoByDay(start, end, tz) {
  const apiKey = mustProp('GELATO_API_KEY');
  const url = 'https://order.gelatoapis.com/v4/orders:search';

  const startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');

  const byDay = {};
  let offset = 0;
  const limit = 100;
  let safety = 200;

  while (safety-- > 0) {
    const payload = {
      orderTypes: ['order'],
      createdAtFrom: new Date(start.getTime() - 2 * 24 * 3600 * 1000).toISOString(),
      createdAtTo: end.toISOString(),
      limit: limit,
      offset: offset,
    };

    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-API-KEY': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    if (res.getResponseCode() !== 200) {
      throw new Error('Gelato (' + res.getResponseCode() + '): ' + res.getContentText());
    }

    const data = JSON.parse(res.getContentText());
    const orders = data.orders || [];
    if (orders.length === 0) break;

    for (const order of orders) {
      if (order.financialStatus === 'canceled' || order.financialStatus === 'cancelled') continue;
      if (order.financialStatus === 'refunded') continue;

      const created = order.createdAt;
      if (!created) continue;
      const day = Utilities.formatDate(new Date(created), tz, 'yyyy-MM-dd');
      if (day < startStr || day > endStr) continue;

      const cost = parseFloat(order.totalInclVat || '0');
      if (!cost) continue;
      byDay[day] = (byDay[day] || 0) + cost;
    }

    if (orders.length < limit) break;
    offset += limit;
  }

  return byDay;
}

// ---------- Meta ----------

/**
 * Pulls daily ad spend from the Meta Marketing Insights API, broken out by
 * campaign so we can exclude specific campaigns from the rolled-up daily total.
 *
 * Endpoint: /act_{id}/insights at level=campaign with time_increment=1 returns
 * one row per (campaign, day), each carrying `spend`, `campaign_name`, and
 * `date_start` (yyyy-MM-dd). We drop any campaign whose name matches one of
 * META_EXCLUDED_CAMPAIGN_SUBSTRINGS (case-insensitive), then sum to daily.
 *
 * Returns { 'yyyy-MM-dd': number } in the ad account's local currency.
 *
 * Timezone note: Meta buckets `date_start` by the AD ACCOUNT's timezone, which
 * may differ from the spreadsheet timezone. For Elder Emo both should be ET so
 * this aligns naturally. If you ever see Meta off by one day vs Shopify, the
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

  // Lowercase the exclusion list once for case-insensitive matching.
  const excludes = META_EXCLUDED_CAMPAIGN_SUBSTRINGS.map((s) => s.toLowerCase());

  const byDay = {};
  const purchases = {};
  const value = {};
  const excludedSeen = {};  // {campaignName: totalExcludedSpend} for logging
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
      const isExcluded = excludes.some((sub) => name.indexOf(sub) !== -1);
      if (isExcluded) {
        excludedSeen[row.campaign_name] =
          (excludedSeen[row.campaign_name] || 0) + spend;
        continue;
      }

      byDay[day] = (byDay[day] || 0) + spend;
      purchases[day] = (purchases[day] || 0) + bought;
      value[day] = (value[day] || 0) + boughtValue;
    }

    url = (data.paging && data.paging.next) ? data.paging.next : null;
  }

  // Log what we excluded so you can sanity-check (visible in the Execution log).
  const excludedNames = Object.keys(excludedSeen);
  if (excludedNames.length > 0) {
    Logger.log('Meta: excluded ' + excludedNames.length + ' campaign(s) by name match:');
    excludedNames.forEach(function (n) {
      Logger.log('  - "' + n + '"  $' + excludedSeen[n].toFixed(2));
    });
  }

  return { spend: byDay, purchases: purchases, value: value };
}

/** Daily Meta spend only, for callers that predate purchases (e.g. testMetaInsights). */
function fetchMetaByDay(start, end, tz) {
  return fetchMetaDaily_(start, end, tz).spend;
}

// ---------- Sheet writing ----------

/**
 * Writes a set of full rows to `sheet` in as few setValues calls as possible.
 * `rowMap` maps a 1-based sheet row number to that row's complete value array
 * (plain values and/or formula strings). Row numbers are grouped into
 * contiguous runs and each run is written with a single setValues, so N
 * scattered updates cost (number of runs) writes instead of N. Only rows
 * present in `rowMap` are written, so formulas already living in untouched
 * rows are never disturbed. Each row is normalized to `width` columns so the
 * block handed to setValues is always rectangular.
 */
function flushRowsInRuns_(sheet, rowMap, width) {
  const rowNums = Array.from(rowMap.keys()).sort(function (a, b) { return a - b; });
  let i = 0;
  while (i < rowNums.length) {
    let j = i;
    while (j + 1 < rowNums.length && rowNums[j + 1] === rowNums[j] + 1) j++;
    const startRow = rowNums[i];
    const block = [];
    for (let k = i; k <= j; k++) {
      let row = rowMap.get(rowNums[k]);
      if (row.length < width) {
        row = row.slice();
        while (row.length < width) row.push('');
      } else if (row.length > width) {
        row = row.slice(0, width);
      }
      block.push(row);
    }
    sheet.getRange(startRow, 1, block.length, width).setValues(block);
    i = j + 1;
  }
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
/** profit = net − printify − gelato − meta − fees − google  (D − F − G − H − I − L) */
function profitFormula_(row) {
  return `=D${row}-F${row}-G${row}-H${row}-I${row}-L${row}`;
}

function writeRows(rows) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Run setup() first.');

  const existing = sheet.getDataRange().getValues();
  const headerRow = existing[0];
  // Guard: writing the 12-column layout into a sheet whose header still stops at K
  // would put google_spend formulas under no header, where Profit Combined cannot
  // find them. Fail loudly with the fix instead.
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
  const WIDTH = PNL_WIDTH;  // daily_pnl columns A..L

  // Build a full 12-column row for a given sheet row number. H (meta_spend),
  // J (profit) and L (google_spend) are written as formula STRINGS: setValues
  // enters any string that begins with "=" as a real formula, so we no longer need
  // the separate per-row setFormula pass the old version ran. That pass was two
  // extra Sheets round trips PER row, on top of the per-row setValues, and is what
  // made big backfills crawl. meta_spend still checks the meta_input override tab
  // first and falls back to the API value baked into the formula.
  function buildRow(r, rowNum) {
    const net = r.shopify_revenue - r.shopify_refunds;
    const feesEst = net > 0
      ? (r.shopify_revenue * SHOPIFY_FEE_PERCENT) + (r.shopify_orders * SHOPIFY_FEE_FIXED)
      : 0;
    const apiMeta = round2(r.meta_spend || 0);
    const metaFormula =
      `=IFERROR(VLOOKUP(A${rowNum}, meta_input!A:B, 2, FALSE), ${apiMeta})`;
    return [
      r.date,                       // A: date
      round2(r.shopify_revenue),    // B
      round2(r.shopify_refunds),    // C
      round2(net),                  // D: shopify_net
      r.shopify_orders,             // E
      round2(r.printify_cost),      // F
      round2(r.gelato_cost),        // G
      metaFormula,                  // H: meta_spend (override-aware formula)
      round2(feesEst),              // I: shopify_fees_est
      profitFormula_(rowNum),       // J: profit
      now,                          // K: last_updated
      googleFormula_(rowNum),       // L: google_spend (lookup into google_input)
      r.meta_orders || 0,           // M: shopify_meta_orders
      round2(r.meta_revenue),       // N: shopify_meta_revenue
      r.google_orders || 0,         // O: shopify_google_orders
      round2(r.google_revenue),     // P: shopify_google_revenue
      round2(r.meta_purchases),     // Q: meta_purchases
      round2(r.meta_purchase_value),// R: meta_purchase_value
      googleColFormula_(rowNum, 3), // S: google_conversions (google_input C)
      googleColFormula_(rowNum, 4), // T: google_conv_value (google_input D)
    ];
  }

  // Partition incoming rows into in-place updates (date already in the sheet)
  // and appends (new date). Updates go into a map keyed by their existing sheet
  // row so we can flush them in contiguous runs; appends are collected in order
  // and get their row numbers when we know where the tail starts.
  const updates = new Map();   // 1-based sheet row -> full row values
  const newRows = [];

  for (const r of rows) {
    const existingRow = dateToRow[r.date];
    if (existingRow) {
      updates.set(existingRow, buildRow(r, existingRow));
    } else {
      newRows.push(r);
    }
  }

  // Flush updates in contiguous runs. For the common cases (runDaily re-pulling
  // the trailing window, or a backfill chunk landing on already-present dates)
  // the touched rows form a single run, so this is one setValues.
  flushRowsInRuns_(sheet, updates, WIDTH);

  // Flush appends as one contiguous block. Their sheet rows start right after
  // the current last row and are known up front, so each row's H/J/L formulas can
  // reference the correct row number.
  if (newRows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    const block = newRows.map(function (r, i) { return buildRow(r, startRow + i); });
    sheet.getRange(startRow, 1, block.length, WIDTH).setValues(block);
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
    gelato_cost: 0,
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
  return Math.round(n * 100) / 100;
}

// ---------- GA4 ----------

/**
 * Orchestrates the GA4 pull: five reports (site-wide daily, by-device daily,
 * traffic sources, landing pages, products) over the same window, each
 * upserted into its own tab keyed appropriately. Called from runGADaily with
 * the trailing-30 window.
 *
 * The five reports answer different CRO questions:
 * - "daily" answers "how did the site do" — one row per day, no breakdown.
 * - "by_device" — read the mobile/desktop delta on each funnel step. Per the
 *   CRO playbook this MUST stay split; averaging the two is the #1 mistake.
 * - "traffic_sources" — where conversions come from. Intent-based search
 *   behaves differently from interruption-based social.
 * - "landing_pages" — where users ENTER. Bounce/conversion by entry point.
 *   The skill calls bounce-by-landing-page a top-of-funnel diagnostic.
 * - "products" — merchandising. ATC-rate vs item-views and view-to-purchase
 *   per product surface the bestsellers-vs-actual-sellers gap.
 *
 * Each report is independent in the data sense, but they run sequentially: if
 * the first one throws (schema break, metric renamed) the rest don't run.
 * That's intentional — runGADaily expects loud failures so you can diagnose
 * which report broke.
 */
function runGA4Pull_(start, end, tz) {
  checkAnalyticsDataAvailable_();

  const daily = fetchGA4Daily(start, end, tz);
  upsertGARows_(GA_DAILY_TAB, GA_DAILY_HEADERS, ['date'], daily);
  Logger.log('GA4 daily: ' + daily.length + ' rows upserted into ' + GA_DAILY_TAB + '.');

  const byDevice = fetchGA4ByDevice(start, end, tz);
  upsertGARows_(GA_DEVICE_TAB, GA_DEVICE_HEADERS, ['date', 'device'], byDevice);
  Logger.log('GA4 by-device: ' + byDevice.length + ' rows upserted into ' + GA_DEVICE_TAB + '.');

  const traffic = fetchGA4TrafficSources(start, end, tz);
  upsertGARows_(GA_TRAFFIC_TAB, GA_TRAFFIC_HEADERS, ['date', 'source', 'medium'], traffic);
  Logger.log('GA4 traffic-sources: ' + traffic.length + ' rows upserted into ' + GA_TRAFFIC_TAB + '.');

  const landing = fetchGA4LandingPages(start, end, tz);
  upsertGARows_(GA_LANDING_TAB, GA_LANDING_HEADERS, ['date', 'landing_page', 'device'], landing);
  Logger.log('GA4 landing-pages: ' + landing.length + ' rows upserted into ' + GA_LANDING_TAB + '.');

  const products = fetchGA4Products(start, end, tz);
  upsertGARows_(GA_PRODUCTS_TAB, GA_PRODUCTS_HEADERS, ['date', 'product_name'], products);
  Logger.log('GA4 products: ' + products.length + ' rows upserted into ' + GA_PRODUCTS_TAB + '.');

  // Total rows fetched across all five reports. backfillGA4History uses this to
  // detect when it has walked back past the start of available GA data (several
  // consecutive all-empty chunks). runGADaily ignores the return value.
  return daily.length + byDevice.length + traffic.length + landing.length + products.length;
}

/**
 * Confirms the Analytics Data advanced service is available. If it's not
 * enabled in the editor, Apps Script throws a ReferenceError on AnalyticsData
 * with no context — this gives a clear, actionable message instead.
 */
function checkAnalyticsDataAvailable_() {
  if (typeof AnalyticsData === 'undefined') {
    throw new Error(
      'The Analytics Data advanced service is not enabled. ' +
      'In the Apps Script editor: Services (+ in left sidebar) → ' +
      '"Google Analytics Data API" → Add. Default identifier "AnalyticsData".'
    );
  }
}

/**
 * Low-level GA4 report runner with pagination. The Data API caps a single
 * response at 250k rows; for landing-page or product reports over a 30-day
 * window that's almost never reached, but a high-cardinality dimension on a
 * long backfill might. Loops until either the API stops returning rows or we
 * hit a safety cap (50 pages * 100k rows = 5M rows would be silly).
 */
function runGAReport_(dimensions, metrics, startDate, endDate) {
  const propertyId = mustProp('GA4_PROPERTY_ID');
  const pageSize = 100000;
  const allRows = [];
  let offset = 0;
  let safety = 50;

  while (safety-- > 0) {
    const request = {
      dateRanges: [{ startDate: startDate, endDate: endDate }],
      dimensions: dimensions.map(function (d) { return { name: d }; }),
      metrics: metrics.map(function (m) { return { name: m }; }),
      limit: pageSize,
      offset: offset,
      keepEmptyRows: false,
    };
    const response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);
    const rows = response.rows || [];
    for (let i = 0; i < rows.length; i++) allRows.push(rows[i]);

    if (rows.length < pageSize) break;  // last page
    offset += pageSize;
  }

  return allRows;
}

/**
 * Safe divide — returns 0 if denominator is 0/null/undefined. Used everywhere
 * we compute a rate or per-unit metric so we never write #DIV/0 or NaN into
 * a cell.
 */
function safeDiv_(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

/**
 * Site-wide daily report: one row per day with the full top-of-funnel +
 * ecommerce funnel + revenue numbers. Used to answer "how is the site doing
 * overall" and to compute headline conversion rate (purchases / sessions).
 *
 * Metric notes:
 * - engagementRate and bounceRate come back as 0..1 fractions; we round to 4
 *   decimals so a 12.34% rate stores as 0.1234.
 * - averageSessionDuration is in seconds.
 * - addToCarts / checkouts / ecommercePurchases are *event counts* (not user
 *   counts), which is what the CRO funnel rates need.
 */
function fetchGA4Daily(start, end, tz) {
  const range = gaDateRange_(start, end, tz);
  // Main fetch (10 metrics — at the GA4 per-request cap).
  const metrics = [
    'sessions', 'totalUsers', 'newUsers',
    'engagementRate', 'bounceRate', 'averageSessionDuration',
    'addToCarts', 'checkouts', 'ecommercePurchases', 'purchaseRevenue',
  ];
  const raw = runGAReport_(['date'], metrics, range.startDate, range.endDate);

  const rows = raw.map(function (r) {
    const m = r.metricValues;
    return {
      date: gaDimDateToYmd_(r.dimensionValues[0].value),
      sessions: parseInt(m[0].value || '0', 10),
      total_users: parseInt(m[1].value || '0', 10),
      new_users: parseInt(m[2].value || '0', 10),
      engagement_rate: round4(parseFloat(m[3].value || '0')),
      bounce_rate: round4(parseFloat(m[4].value || '0')),
      avg_session_duration_sec: round2(parseFloat(m[5].value || '0')),
      add_to_carts: parseInt(m[6].value || '0', 10),
      checkouts: parseInt(m[7].value || '0', 10),
      purchases: parseInt(m[8].value || '0', 10),
      revenue: round2(parseFloat(m[9].value || '0')),
      view_items: 0,  // filled in by the second fetch below
    };
  });

  // Second fetch: view_item event counts per day. Done separately because
  // adding itemViewEvents to the main fetch would push it past the 10-metric
  // cap. The merge is by date.
  const viewItemsByDate = fetchGA4ViewItemsByDate_(['date'], range);
  rows.forEach(function (r) {
    r.view_items = viewItemsByDate[r.date] || 0;
  });

  rows.forEach(addComputedFunnelMetrics_);
  return rows;
}

/**
 * Daily report broken out by device category (mobile/desktop/tablet). This is
 * where the CRO diagnostics happen — the playbook is to read each funnel step
 * on each device and look for material deltas (small delta = step-level issue,
 * large delta = device-specific issue). NEVER average the two; that hides the
 * signal entirely.
 */
function fetchGA4ByDevice(start, end, tz) {
  const range = gaDateRange_(start, end, tz);
  // 9 metrics — under the 10-cap. We include bounceRate here because by-device
  // bounce is one of the headline CRO diagnostics.
  const metrics = [
    'sessions', 'totalUsers', 'engagedSessions',
    'engagementRate', 'bounceRate',
    'addToCarts', 'checkouts', 'ecommercePurchases', 'purchaseRevenue',
  ];
  const raw = runGAReport_(['date', 'deviceCategory'], metrics, range.startDate, range.endDate);

  const rows = raw.map(function (r) {
    const m = r.metricValues;
    return {
      date: gaDimDateToYmd_(r.dimensionValues[0].value),
      device: r.dimensionValues[1].value,
      sessions: parseInt(m[0].value || '0', 10),
      total_users: parseInt(m[1].value || '0', 10),
      engaged_sessions: parseInt(m[2].value || '0', 10),
      engagement_rate: round4(parseFloat(m[3].value || '0')),
      bounce_rate: round4(parseFloat(m[4].value || '0')),
      add_to_carts: parseInt(m[5].value || '0', 10),
      checkouts: parseInt(m[6].value || '0', 10),
      purchases: parseInt(m[7].value || '0', 10),
      revenue: round2(parseFloat(m[8].value || '0')),
      view_items: 0,
    };
  });

  // Second fetch: view_item event counts per (date, device). Merge by composite key.
  const viewItemsByKey = fetchGA4ViewItemsByDate_(['date', 'deviceCategory'], range);
  rows.forEach(function (r) {
    r.view_items = viewItemsByKey[r.date + '|' + r.device] || 0;
  });

  rows.forEach(addComputedFunnelMetrics_);
  return rows;
}

/**
 * Daily report broken out by traffic source + medium. Used to attribute
 * sessions and purchases back to where the traffic came from, e.g.
 * (google / organic), (m.facebook.com / referral), (newsletter / email).
 *
 * Note: this is session-source (the source that drove the SESSION), not the
 * first-touch source. For first-touch use firstUserSource/firstUserMedium
 * instead, but session-source is the right answer for "what should I buy more
 * of" decisions because it's about behaviour in-session.
 */
function fetchGA4TrafficSources(start, end, tz) {
  const range = gaDateRange_(start, end, tz);
  const metrics = ['sessions', 'totalUsers', 'ecommercePurchases', 'purchaseRevenue'];
  const raw = runGAReport_(
    ['date', 'sessionSource', 'sessionMedium'],
    metrics, range.startDate, range.endDate
  );

  const rows = raw.map(function (r) {
    const m = r.metricValues;
    return {
      date: gaDimDateToYmd_(r.dimensionValues[0].value),
      source: r.dimensionValues[1].value,
      medium: r.dimensionValues[2].value,
      sessions: parseInt(m[0].value || '0', 10),
      total_users: parseInt(m[1].value || '0', 10),
      purchases: parseInt(m[2].value || '0', 10),
      revenue: round2(parseFloat(m[3].value || '0')),
    };
  });

  rows.forEach(function (r) {
    r.conversion_rate = round4(safeDiv_(r.purchases, r.sessions));
    r.aov = round2(safeDiv_(r.revenue, r.purchases));
    r.revenue_per_user = round2(safeDiv_(r.revenue, r.total_users));
    r.revenue_per_session = round2(safeDiv_(r.revenue, r.sessions));
  });
  return rows;
}

/**
 * Helper: pull view_item event counts grouped by the given dimensions, return
 * as a map keyed on the joined dimension values. Used by fetchGA4Daily and
 * fetchGA4ByDevice to merge view_items into their main results without
 * busting the 10-metric-per-request cap of those main fetches.
 *
 * Uses eventCount metric with a dimension filter on eventName='view_item' —
 * this is more reliable than the item-scoped itemViewEvents metric across
 * arbitrary dimension combinations.
 */
function fetchGA4ViewItemsByDate_(dimensions, range) {
  const propertyId = mustProp('GA4_PROPERTY_ID');
  const request = {
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    dimensions: dimensions.map(function (d) { return { name: d }; }),
    metrics: [{ name: 'eventCount' }],
    // Filter: only count view_item events. Without this we'd be summing every
    // event type GA4 tracks, which is meaningless.
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: 'view_item' },
      },
    },
    limit: 100000,
    keepEmptyRows: false,
  };
  const response = AnalyticsData.Properties.runReport(request, 'properties/' + propertyId);
  const out = {};
  (response.rows || []).forEach(function (r) {
    const keyParts = r.dimensionValues.map(function (d, i) {
      // The "date" dimension comes back as YYYYMMDD; normalize so it matches
      // the keys we generate in the parent fetch.
      if (dimensions[i] === 'date') return gaDimDateToYmd_(d.value);
      return d.value;
    });
    const key = keyParts.join('|');
    out[key] = parseInt(r.metricValues[0].value || '0', 10);
  });
  return out;
}

/**
 * Landing pages report: date × landing_page × device. This is the workhorse
 * for top-of-funnel CRO work — bounce rate by landing page tells you which
 * entry points are working, conversion rate by landing page tells you which
 * are actually selling, and splitting both by device exposes whether the
 * problem is the page or the platform.
 *
 * Dimension `landingPage` is the path only (no query string) — query strings
 * (utm tags, etc.) explode cardinality without adding diagnostic value. If
 * you ever need campaign-specific landings, switch to landingPagePlusQueryString.
 */
function fetchGA4LandingPages(start, end, tz) {
  const range = gaDateRange_(start, end, tz);
  // 10 metrics — at the GA4 per-request cap.
  const metrics = [
    'sessions', 'totalUsers', 'engagedSessions',
    'engagementRate', 'bounceRate', 'averageSessionDuration',
    'itemViewEvents', 'addToCarts', 'ecommercePurchases', 'purchaseRevenue',
  ];
  const raw = runGAReport_(
    ['date', 'landingPage', 'deviceCategory'],
    metrics, range.startDate, range.endDate
  );

  const rows = raw.map(function (r) {
    const m = r.metricValues;
    return {
      date: gaDimDateToYmd_(r.dimensionValues[0].value),
      landing_page: r.dimensionValues[1].value,
      device: r.dimensionValues[2].value,
      sessions: parseInt(m[0].value || '0', 10),
      total_users: parseInt(m[1].value || '0', 10),
      engaged_sessions: parseInt(m[2].value || '0', 10),
      engagement_rate: round4(parseFloat(m[3].value || '0')),
      bounce_rate: round4(parseFloat(m[4].value || '0')),
      avg_session_duration_sec: round2(parseFloat(m[5].value || '0')),
      view_items: parseInt(m[6].value || '0', 10),
      add_to_carts: parseInt(m[7].value || '0', 10),
      purchases: parseInt(m[8].value || '0', 10),
      revenue: round2(parseFloat(m[9].value || '0')),
    };
  });

  rows.forEach(function (r) {
    r.view_item_rate = round4(safeDiv_(r.view_items, r.sessions));
    r.add_to_cart_rate = round4(safeDiv_(r.add_to_carts, r.sessions));
    r.conversion_rate = round4(safeDiv_(r.purchases, r.sessions));
    r.aov = round2(safeDiv_(r.revenue, r.purchases));
    r.revenue_per_user = round2(safeDiv_(r.revenue, r.total_users));
  });
  return rows;
}

/**
 * Products report: date × product. Uses item-scoped metrics (itemsViewed,
 * itemsAddedToCart, itemsPurchased, etc.) which count items rather than
 * events — the right scope for merchandising analysis.
 *
 * The two headline metrics the CRO skill calls out are add_to_cart_rate and
 * view_to_purchase_rate per product. Both are computed here. Plotting any of
 * these against items_viewed (with traffic as the agnostic variable) is the
 * merchandising loop.
 */
function fetchGA4Products(start, end, tz) {
  const range = gaDateRange_(start, end, tz);
  const metrics = [
    'itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut',
    'itemsPurchased', 'itemRevenue',
  ];
  const raw = runGAReport_(
    ['date', 'itemName'],
    metrics, range.startDate, range.endDate
  );

  const rows = raw.map(function (r) {
    const m = r.metricValues;
    return {
      date: gaDimDateToYmd_(r.dimensionValues[0].value),
      product_name: r.dimensionValues[1].value,
      items_viewed: parseInt(m[0].value || '0', 10),
      items_added_to_cart: parseInt(m[1].value || '0', 10),
      items_checked_out: parseInt(m[2].value || '0', 10),
      items_purchased: parseInt(m[3].value || '0', 10),
      item_revenue: round2(parseFloat(m[4].value || '0')),
    };
  });

  rows.forEach(function (r) {
    r.add_to_cart_rate = round4(safeDiv_(r.items_added_to_cart, r.items_viewed));
    r.view_to_purchase_rate = round4(safeDiv_(r.items_purchased, r.items_viewed));
    r.aov_per_item = round2(safeDiv_(r.item_revenue, r.items_purchased));
  });
  return rows;
}

/**
 * Computes the full funnel rates and per-user/session economics from raw
 * counts on a row object. Mutates the row in place. Shared by fetchGA4Daily
 * and fetchGA4ByDevice because they use the same metric set.
 *
 * All rates are stored as 0..1 fractions (matching how engagement_rate and
 * bounce_rate come back from the API) — format cells as percentages in the
 * sheet if you want them displayed as %.
 */
function addComputedFunnelMetrics_(r) {
  r.view_item_rate = round4(safeDiv_(r.view_items, r.sessions));
  r.add_to_cart_rate = round4(safeDiv_(r.add_to_carts, r.sessions));
  r.cart_to_checkout_rate = round4(safeDiv_(r.checkouts, r.add_to_carts));
  r.checkout_to_purchase_rate = round4(safeDiv_(r.purchases, r.checkouts));
  r.conversion_rate = round4(safeDiv_(r.purchases, r.sessions));
  r.aov = round2(safeDiv_(r.revenue, r.purchases));
  r.revenue_per_user = round2(safeDiv_(r.revenue, r.total_users));
  r.revenue_per_session = round2(safeDiv_(r.revenue, r.sessions));
}

/**
 * Convert a [start, end) window (where `end` is the start of tomorrow) to
 * GA4's inclusive {startDate, endDate} as yyyy-MM-dd strings in the sheet tz.
 * GA4 uses calendar-day boundaries in the property's reporting timezone, which
 * for our purposes is close enough to the sheet timezone (ET ↔ ET).
 */
function gaDateRange_(start, end, tz) {
  const startDate = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  const endMinusOne = new Date(end.getTime() - 24 * 3600 * 1000);
  const endDate = Utilities.formatDate(endMinusOne, tz, 'yyyy-MM-dd');
  return { startDate: startDate, endDate: endDate };
}

/** GA4 returns the `date` dimension as 'YYYYMMDD' with no separators — convert. */
function gaDimDateToYmd_(s) {
  return s.substring(0, 4) + '-' + s.substring(4, 6) + '-' + s.substring(6, 8);
}

/**
 * Composite-key upsert into a GA tab.
 *
 * Existence check: to decide which incoming rows already exist we only need the
 * KEY columns, so we read just those (as display strings) instead of the whole
 * tab. This is the fix for backfillGA4History timing out. The prior version read
 * every column of the entire accumulated tab AND called Utilities.formatDate on
 * every date cell to build its key map, once per report per chunk; on tabs that
 * had grown to tens of thousands of rows (ga_products, ga_landing_pages) that
 * read-and-key pass alone ran into minutes and blew the execution limit. Reading
 * only the key columns as display strings removes the wide read and the
 * per-cell date formatting: the date column is formatted yyyy-mm-dd so its
 * display string already equals the key form, and string key columns come back
 * as themselves. This works whether the stored date is a real Date or text.
 *
 * Writes: matched rows are updated in place (grouped into contiguous runs by
 * flushRowsInRuns_, typically one run), unmatched rows are appended in one
 * block. A backfill into brand-new dates produces zero updates and a single
 * append write.
 */
function upsertGARows_(tabName, headers, keyCols, rows) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    throw new Error('Tab "' + tabName + '" not found. Run setup() to create GA tabs.');
  }

  const width = headers.length;

  // Key column indices from the canonical header order (these tabs are always
  // created with exactly `headers`, so we don't need to read the sheet's header
  // row to locate them).
  const keyColIdxs = keyCols.map(function (c) {
    const idx = headers.indexOf(c);
    if (idx === -1) throw new Error('Key column "' + c + '" not found in ' + tabName);
    return idx;
  });
  const maxKeyCol = Math.max.apply(null, keyColIdxs) + 1;  // 1-based column count to read

  const lastRow = sheet.getLastRow();
  const keyToRow = {};  // "k1|k2|..." -> 1-based sheet row number
  if (lastRow >= 2) {
    // Read ONLY the key columns, as display strings. Data starts at row 2 (row 1
    // is the header).
    const keyData = sheet.getRange(2, 1, lastRow - 1, maxKeyCol).getDisplayValues();
    for (let i = 0; i < keyData.length; i++) {
      const parts = [];
      for (let k = 0; k < keyColIdxs.length; k++) {
        parts.push(keyData[i][keyColIdxs[k]]);
      }
      keyToRow[parts.join('|')] = i + 2;  // +2: header is row 1, data starts at row 2
    }
  }

  const now = new Date();
  const updates = new Map();  // 1-based sheet row -> full row values
  const toAppend = [];

  for (const r of rows) {
    const keyParts = keyCols.map(function (c) { return String(r[c]); });
    const key = keyParts.join('|');
    const rowValues = headers.map(function (h) {
      if (h === 'last_updated') return now;
      return r[h] !== undefined ? r[h] : '';
    });

    const existingRow = keyToRow[key];
    if (existingRow) {
      updates.set(existingRow, rowValues);
    } else {
      toAppend.push(rowValues);
    }
  }

  // Flush updates in contiguous runs (see flushRowsInRuns_).
  flushRowsInRuns_(sheet, updates, width);

  // Flush appends in a single block write.
  if (toAppend.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, toAppend.length, width).setValues(toAppend);
  }
}

/**
 * Round to 4 decimal places. Used for GA4 rate metrics (engagement, bounce)
 * which come back as 0..1 fractions — 4 decimals captures enough precision
 * to read e.g. 0.4823 = 48.23% bounce rate without scientific notation in the
 * cell.
 */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * One-off smoke test for the GA4 pull. Fetches the last 7 days of the daily
 * report and logs a sample. Run this before adding the daily trigger so you
 * can confirm:
 *   1. The Analytics Data advanced service is enabled.
 *   2. GA4_PROPERTY_ID is set and accessible.
 *   3. The metrics are actually being returned (non-zero numbers if you have
 *      any traffic).
 */
function testGA4Daily() {
  checkAnalyticsDataAvailable_();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const end = startOfDayInTz(new Date(Date.now() + 24 * 3600 * 1000), tz);
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const rows = fetchGA4Daily(start, end, tz);
  if (rows.length === 0) {
    Logger.log('No GA4 rows returned for the last 7 days. Check the property ID and ' +
      'that the property actually has traffic.');
    return;
  }
  Logger.log('GA4 fetched ' + rows.length + ' daily rows. Last 3:');
  rows.slice(-3).forEach(function (r) {
    Logger.log('  ' + r.date + ' — sessions: ' + r.sessions +
      ', purchases: ' + r.purchases + ', revenue: $' + r.revenue.toFixed(2) +
      ', engagement: ' + (r.engagement_rate * 100).toFixed(1) + '%');
  });
}

/**
 * Manual GA4 backfill. Run this any time you want to populate or refresh GA
 * tabs over a custom window. Targets the last GA_BACKFILL_TARGET_DAYS days
 * (a multi-year backstop by default) and stops early once GA stops returning
 * data. How far back you actually get is capped by GA4's data retention. If you
 * haven't already, set retention to its 14-month maximum in Admin, Data
 * Settings, Data Retention. Standard date-based reports often reach further,
 * but retention is the reliable floor. Anything older than what GA still holds
 * comes back empty and ends the backfill.
 *
 * Resumable across runs in the same pattern as backfillAllHistory:
 *   - Walks backwards in 30-day chunks.
 *   - Saves cursor (the date we've processed back to) after each chunk.
 *   - Exits gracefully before the 6-minute Apps Script limit so the next run
 *     can pick up where this one left off.
 *   - Clears the cursor when the target window has been fully processed.
 *
 * Resumability matters more here than it used to: with five GA tabs now (was
 * three), each chunk does more API calls AND each upsert scans a growing
 * accumulated tab to find write positions. A full year of backfill against an
 * already-populated set of tabs can easily exceed 6 minutes — run repeatedly
 * until "GA4 backfill complete" appears in the log.
 *
 * If you change GA_BACKFILL_TARGET_DAYS mid-run (e.g. to 1500 after extending
 * retention to 50 months), call resetGABackfillCheckpoint() first so the new
 * target is honored from a fresh starting point.
 */
function backfillGA4History() {
  return withLock_('backfillGA4History', backfillGA4HistoryUnlocked_);
}

function backfillGA4HistoryUnlocked_() {
  checkAnalyticsDataAvailable_();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const props = PropertiesService.getScriptProperties();
  const startTime = Date.now();

  const today = new Date();
  const overallEnd = startOfDayInTz(new Date(today.getTime() + 24 * 3600 * 1000), tz);
  const overallStart = new Date(overallEnd.getTime() - GA_BACKFILL_TARGET_DAYS * 24 * 3600 * 1000);

  // Resume from checkpoint, or start from "today" (the end of the target window).
  const cursorIso = props.getProperty(GA_BACKFILL_CHECKPOINT_KEY);
  let cursor = cursorIso ? new Date(cursorIso) : overallEnd;

  Logger.log('GA4 backfill: target window ' +
    Utilities.formatDate(overallStart, tz, 'yyyy-MM-dd') + ' → ' +
    Utilities.formatDate(overallEnd, tz, 'yyyy-MM-dd') +
    '. Resuming from ' + Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') + '.');

  let chunks = 0;
  let reachedBeginning = false;
  // Consecutive all-empty chunks seen. GA4 returns no rows once we've walked
  // past the start of available data (or past the property's retention
  // horizon), so a short streak of empties is our "reached the beginning"
  // signal, the same idea the Shopify backfill uses with zero-order chunks.
  // 3 chunks = ~90 empty days, which an active store won't produce mid-history.
  const EMPTY_CHUNK_STOP = 3;
  let emptyStreak = 0;

  while (Date.now() - startTime < BACKFILL_MAX_RUNTIME_MS) {
    // Hard stop: cursor has walked all the way back to the target start.
    if (cursor.getTime() <= overallStart.getTime()) {
      reachedBeginning = true;
      break;
    }
    const chunkEnd = new Date(cursor);
    const chunkStart = new Date(Math.max(
      cursor.getTime() - BACKFILL_CHUNK_DAYS * 24 * 3600 * 1000,
      overallStart.getTime()
    ));

    Logger.log('  chunk: ' +
      Utilities.formatDate(chunkStart, tz, 'yyyy-MM-dd') + ' → ' +
      Utilities.formatDate(chunkEnd, tz, 'yyyy-MM-dd'));

    const rowsFetched = runGA4Pull_(chunkStart, chunkEnd, tz);
    chunks++;

    cursor = chunkStart;
    // Save checkpoint AFTER the chunk's writes have landed, so a crash
    // mid-chunk just replays that chunk rather than skipping it.
    props.setProperty(GA_BACKFILL_CHECKPOINT_KEY, cursor.toISOString());

    // Early stop once GA returns nothing for several chunks in a row.
    if (rowsFetched === 0) {
      emptyStreak++;
      if (emptyStreak >= EMPTY_CHUNK_STOP) {
        Logger.log('  ' + emptyStreak + ' consecutive empty chunks, assuming ' +
          'start of available GA data reached.');
        reachedBeginning = true;
        break;
      }
    } else {
      emptyStreak = 0;
    }
  }

  if (reachedBeginning) {
    props.deleteProperty(GA_BACKFILL_CHECKPOINT_KEY);
    Logger.log('GA4 backfill complete. ' + chunks + ' chunks processed this run.');
  } else {
    Logger.log('GA4 backfill: time limit approaching. ' + chunks +
      ' chunks processed this run. Run backfillGA4History again to resume from ' +
      Utilities.formatDate(cursor, tz, 'yyyy-MM-dd') + '.');
  }
}

/** Manually reset the GA4 backfill checkpoint if you want to start over. */
function resetGABackfillCheckpoint() {
  PropertiesService.getScriptProperties().deleteProperty(GA_BACKFILL_CHECKPOINT_KEY);
  Logger.log('GA4 backfill checkpoint cleared.');
}

// ---------- Meta token test (step 7) ----------

/**
 * One-off check that the Meta system-user token works. Hits /me/adaccounts —
 * the most read-only endpoint there is, just lists what the token can see.
 * Useful any time you suspect Meta is the source of a failure.
 *
 * Run from the Apps Script editor dropdown, then read View → Logs.
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
