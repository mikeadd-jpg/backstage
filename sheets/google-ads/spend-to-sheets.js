/**
 * GOOGLE ADS → BRAND P&L SHEETS
 * Lives in: Google Ads, on the "We Supply Threads Holding" MANAGER account (379-053-6041),
 *           Tools → Bulk actions → Scripts. Not in Apps Script.
 *
 * Writes each brand's daily Google Ads cost into the "google_input" tab of that brand's
 * P&L sheet. The brand sheet's daily_pnl.google_spend column looks it up with a formula,
 * so spend appears without the brand's own script having to run.
 *
 * Runs from the manager account so one script covers every brand, and so it needs no
 * Google Ads API developer token (Ads Scripts are authorised as the signed-in user).
 *
 * Each run rewrites the trailing LOOKBACK_DAYS (late-arriving click corrections settle
 * within a few days) and keeps every older row as it was. A brand whose tab is empty
 * gets BACKFILL_DAYS of history on its first run.
 *
 * SETUP:
 *   1. In each brand sheet, run setup() from its Apps Script first, so google_input exists.
 *   2. Paste this into a new script on the manager account. Authorize.
 *   3. Run it once (Preview does not write to sheets — use Run) and check the logs.
 *   4. Set its frequency to Hourly.
 *
 * Adding a brand: one line in ACCOUNTS. A blank or PASTE_ sheet id is skipped.
 */

const ACCOUNTS = {
  '708-092-3760': { brand: 'Elder Emo', sheetId: '14HUqCeZEE1_mPVFWYXGjvVX8R49zOjcgFR-JQK7V48U' },
  '821-248-3578': { brand: 'PopPunks',  sheetId: '1kuKTWTsHgSEaZjbt-EWhCOBLU-UAV1TQuASeDU6Vhi0' },
  '787-176-6513': { brand: 'Wallspoke', sheetId: '1quc_JWpsG852QWX91Uk5K6RqvirZX8n5Pt-vJI5oaaI' },
};

const TAB = 'google_input';
const LOOKBACK_DAYS = 35;
const BACKFILL_DAYS = 730;

function main() {
  const ids = [];
  Object.keys(ACCOUNTS).forEach((id) => {
    const s = ACCOUNTS[id].sheetId;
    if (s && s.indexOf('PASTE_') !== 0) ids.push(id);
    // Said out loud, so a missing brand in the log is never a mystery.
    else Logger.log('SKIPPED ' + ACCOUNTS[id].brand + ' (' + id + '): no sheet id in ACCOUNTS yet.');
  });
  if (!ids.length) { Logger.log('No accounts with a sheet id.'); return; }

  const it = AdsManagerApp.accounts().withIds(ids).get();
  while (it.hasNext()) {
    const account = it.next();
    const cfg = ACCOUNTS[account.getCustomerId()];
    if (!cfg) continue;
    try {
      AdsManagerApp.select(account);
      syncAccount_(cfg);
    } catch (e) {
      // One brand failing must not stop the others.
      Logger.log('FAILED ' + cfg.brand + ': ' + e.message);
    }
  }
}

function syncAccount_(cfg) {
  const tz = AdsApp.currentAccount().getTimeZone();
  const sheet = SpreadsheetApp.openById(cfg.sheetId).getSheetByName(TAB);
  if (!sheet) throw new Error('no "' + TAB + '" tab — run setup() in that sheet\'s Apps Script first');

  // Existing rows, keyed by yyyy-MM-dd.
  const byDate = {};
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const d = values[i][0];
    const key = d instanceof Date ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) byDate[key] = Number(values[i][1]) || 0;
  }

  const days = Object.keys(byDate).length ? LOOKBACK_DAYS : BACKFILL_DAYS;
  const now = new Date();
  const to = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const from = Utilities.formatDate(new Date(now.getTime() - days * 86400000), tz, 'yyyy-MM-dd');

  // Zero-fill the window first: a day with no spend returns no row, and it must
  // overwrite any stale value rather than keep it.
  for (let t = new Date(from + 'T12:00:00Z'); Utilities.formatDate(t, 'UTC', 'yyyy-MM-dd') <= to; t = new Date(t.getTime() + 86400000)) {
    byDate[Utilities.formatDate(t, 'UTC', 'yyyy-MM-dd')] = 0;
  }

  const rows = AdsApp.search(
    'SELECT segments.date, metrics.cost_micros FROM customer ' +
    "WHERE segments.date BETWEEN '" + from + "' AND '" + to + "'"
  );
  let windowTotal = 0;
  while (rows.hasNext()) {
    const r = rows.next();
    const cost = Number(r.metrics.costMicros || 0) / 1e6;
    byDate[r.segments.date] = Math.round(cost * 100) / 100;
    windowTotal += cost;
  }

  const out = Object.keys(byDate).sort().map((d) => [d, byDate[d]]);
  // The tab grows a row a day, and a write past the sheet's grid throws.
  if (sheet.getMaxRows() < out.length + 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), out.length + 1 - sheet.getMaxRows());
  }
  sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2).clearContent();
  if (out.length) {
    sheet.getRange(2, 1, out.length, 2).setValues(out);
    sheet.getRange(2, 1, out.length, 1).setNumberFormat('yyyy-mm-dd');
    sheet.getRange(2, 2, out.length, 1).setNumberFormat('$#,##0.00');
  }
  // Two totals on purpose: the refreshed window alone reads as "this brand spends
  // nothing" whenever its spend is older than LOOKBACK_DAYS.
  const allTotal = out.reduce((s, r) => s + r[1], 0);
  const spendDays = out.filter((r) => r[1] > 0).length;
  Logger.log(cfg.brand + ': ' + (days === BACKFILL_DAYS ? 'BACKFILLED ' : 'refreshed ') +
    from + ' to ' + to + ' ($' + windowTotal.toFixed(2) + ' in that window). ' +
    'Tab now holds ' + out.length + ' days, $' + allTotal.toFixed(2) + ' all-time across ' +
    spendDays + ' days with spend' + (out.length ? ', ' + out[0][0] + ' to ' + out[out.length - 1][0] : '') + '.');
}
