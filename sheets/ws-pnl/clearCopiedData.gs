/**
 * ONE-TIME: clears the PopPunks data that came along when WS Profit was made as a copy
 * of PP Profit. Keeps every header row, deletes everything under it, and removes the
 * copied dashboard tabs (runDaily rebuilds them from Wallspoke data).
 *
 * Refuses to run anywhere except WS Profit, so pasting it into the wrong sheet does
 * nothing. Delete this function once it has run.
 */
function clearCopiedData() {
  const WS_PROFIT_ID = '1quc_JWpsG852QWX91Uk5K6RqvirZX8n5Pt-vJI5oaaI';
  const ss = SpreadsheetApp.getActive();
  if (ss.getId() !== WS_PROFIT_ID) {
    throw new Error('Refusing to run: this is "' + ss.getName() + '", not WS Profit. Nothing was changed.');
  }

  // Data tabs: keep row 1, clear the rest.
  ['daily_pnl', 'meta_input', 'google_input'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { Logger.log(name + ': not present, skipped.'); return; }
    const rows = sh.getLastRow() - 1;
    if (rows > 0) sh.getRange(2, 1, rows, sh.getMaxColumns()).clearContent();
    Logger.log(name + ': cleared ' + Math.max(rows, 0) + ' rows, header kept.');
  });

  // Dashboard tabs show PopPunks numbers until rebuilt; remove them so nothing stale
  // is on screen. A spreadsheet must keep one tab, which daily_pnl always is.
  ['today', 'yesterday', 'dashboard_7d', 'dashboard_30d', 'dashboard_mtd', 'dashboard_ytd'].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (sh) { ss.deleteSheet(sh); Logger.log(name + ': removed (runDaily rebuilds it).'); }
  });

  // Run-state copied from PP's script, if Script Properties came along with the copy.
  const props = PropertiesService.getScriptProperties();
  ['backfill_cursor', 'last_run_daily', 'last_run_today'].forEach(function (k) {
    if (props.getProperty(k) !== null) { props.deleteProperty(k); Logger.log('Script property ' + k + ': removed.'); }
  });

  // List what is left, so copied PopPunks credentials are easy to spot.
  const left = Object.keys(props.getProperties()).sort();
  Logger.log('Script properties still set: ' + (left.length ? left.join(', ') : '(none)'));
  Logger.log('Done. Replace any PopPunks values above with Wallspoke ones before running anything else.');
}
