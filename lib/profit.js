// Profitability, read from the "Profit Combined" Google Sheet. The sheet is the source
// of truth: Apps Script in each brand's sheet (runToday / runDaily) builds the numbers,
// and Profit Combined stacks them into one table, combined_flat. Backstage only reads.
//
// Access is a Google service account that the sheet is shared with as Viewer, so this
// can see that one file and nothing else in Drive. The Gmail OAuth client is not reused:
// it belongs to the support inbox and carries only Gmail scopes.
//
// Who may see it is canViewProfit(), checked on every request by the route rather than
// read from the session cookie, so that revoking access takes effect immediately instead
// of whenever a 14 day cookie expires. Today that is the bootstrap admin only.
import { google } from 'googleapis';
import { bootstrapAdmin } from './users.js';

export function canViewProfit(email) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && e === bootstrapAdmin();
}

const RANGE = 'combined_flat!A:Z';
const CACHE_MS = 5 * 60 * 1000; // the sheet updates a few times a day at most
const TZ = process.env.PROFIT_TZ || 'America/New_York'; // the sheet's own clock

let cache = null; // { at, rows }

function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let key;
  try { key = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  const auth = new google.auth.JWT({
    email: key.client_email,
    // Env stores often turn the key's newlines into literal \n.
    key: String(key.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), serviceEmail: key.client_email };
}

const num = (v) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};

function isoDate(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Columns are found by header name, so reordering or adding columns in the sheet
// does not silently shift every number one place.
export async function readProfitRows() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const sheetId = process.env.PROFIT_SHEET_ID;
  if (!sheetId) throw new Error('PROFIT_SHEET_ID is not set');
  const { sheets, serviceEmail } = sheetsClient();

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId, range: RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
    });
  } catch (err) {
    const code = err.code || (err.response && err.response.status);
    if (code === 403 || code === 404) {
      throw new Error('Cannot open the profit sheet. Share it with ' + serviceEmail + ' as Viewer.');
    }
    throw err;
  }

  const [header = [], ...body] = res.data.values || [];
  const col = {};
  header.forEach((h, i) => { col[String(h).trim().toLowerCase()] = i; });
  for (const need of ['brand', 'date', 'shopify_net', 'profit']) {
    if (!(need in col)) throw new Error('combined_flat has no "' + need + '" column');
  }
  const get = (r, name) => (name in col ? r[col[name]] : undefined);

  // Last row wins for a repeated brand and date, matching how runDaily overwrites
  // today's in-progress row with finals.
  const byKey = new Map();
  for (const r of body) {
    const brand = String(get(r, 'brand') || '').trim();
    const date = isoDate(get(r, 'date'));
    if (!brand || !date) continue;
    byKey.set(brand + '|' + date, {
      brand, date,
      revenue: num(get(r, 'shopify_revenue')),
      refunds: num(get(r, 'shopify_refunds')),
      net: num(get(r, 'shopify_net')),
      orders: num(get(r, 'shopify_orders')),
      cogs: num(get(r, 'printify_cost')),
      ads: num(get(r, 'meta_spend')),
      fees: num(get(r, 'shopify_fees_est')),
      profit: num(get(r, 'profit')),
    });
  }
  const rows = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  cache = { at: Date.now(), rows };
  return rows;
}

// --- Periods -------------------------------------------------------------------------
// Windows end today inclusive, with today still in progress, exactly like the sheet's
// own dashboards, so the two agree to the cent.

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function shiftMonth(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

function sum(rows, from, to) {
  const t = { net: 0, orders: 0, cogs: 0, ads: 0, fees: 0, profit: 0, days: 0 };
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    t.net += r.net; t.orders += r.orders; t.cogs += r.cogs; t.ads += r.ads; t.fees += r.fees; t.profit += r.profit;
    t.days++;
  }
  t.costs = t.net - t.profit; // includes anything the sheet books outside the three cost columns
  t.margin = t.net ? t.profit / t.net : null;
  t.mer = t.ads ? t.net / t.ads : null;
  t.perOrder = t.orders ? t.profit / t.orders : null;
  return t;
}

export function summarize(allRows, brand = 'all') {
  const rows = brand === 'all' ? allRows : allRows.filter((r) => r.brand === brand);
  // Collapse brands into one row per day.
  const daily = new Map();
  for (const r of rows) {
    const d = daily.get(r.date) || { date: r.date, net: 0, orders: 0, cogs: 0, ads: 0, fees: 0, profit: 0 };
    d.net += r.net; d.orders += r.orders; d.cogs += r.cogs; d.ads += r.ads; d.fees += r.fees; d.profit += r.profit;
    daily.set(r.date, d);
  }
  const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));

  const today = todayIn(TZ);
  const yesterday = addDays(today, -1);
  const monthStart = today.slice(0, 8) + '01';
  const yearStart = today.slice(0, 4) + '-01-01';
  const lastYear = String(Number(today.slice(0, 4)) - 1);

  const period = (key, label, from, to, pFrom, pTo, compareLabel) => ({
    key, label, from, to, compareLabel,
    current: sum(days, from, to),
    prior: pFrom ? sum(days, pFrom, pTo) : null,
  });

  const periods = [
    period('today', 'Today', today, today, null, null, 'in progress'),
    period('yesterday', 'Yesterday', yesterday, yesterday, addDays(today, -2), addDays(today, -2), 'vs. day before'),
    period('7d', 'Last 7 days', addDays(today, -6), today, addDays(today, -13), addDays(today, -7), 'vs. prior 7 days'),
    period('30d', 'Last 30 days', addDays(today, -29), today, addDays(today, -59), addDays(today, -30), 'vs. prior 30 days'),
    period('mtd', 'Month to date', monthStart, today, shiftMonth(monthStart, -1), shiftMonth(today, -1), 'vs. same days last month'),
    period('ytd', 'Year to date', yearStart, today, lastYear + '-01-01', lastYear + today.slice(4), 'vs. same span last year'),
  ];

  const brands = [...new Set(allRows.map((r) => r.brand))].sort();
  const lastDate = days.length ? days[days.length - 1].date : null;
  return { today, lastDate, brands, periods, daily: days.filter((d) => d.date >= addDays(today, -89)) };
}
