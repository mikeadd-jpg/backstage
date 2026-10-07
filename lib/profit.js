// Profitability, read from the "Profit Combined" Google Sheet. The sheet is the source
// of truth: Apps Script in each brand's sheet (runToday / runDaily) builds the numbers,
// and Profit Combined stacks them into one table, combined_flat. Backstage only reads.
// The scripts themselves are kept in sheets/ for reference; see CLAUDE.md.
//
// Costs come in two families, each split by vendor so either can be shown on its own:
//   production = printify_cost + printful_cost + gelato_cost   (Gelato is Elder Emo only)
//   ad spend   = meta_spend + google_spend       (Google arrives hourly from Google Ads)
// MER is net revenue over TOTAL ad spend, matching the sheets since Google was added.
// Older rows predate the two newer columns and read as 0, which is what they were.
//
// Access is a Google service account that the sheet is shared with as Viewer, so this
// can see that one file and nothing else in Drive. The Gmail OAuth client is not reused:
// it belongs to the support inbox and carries only Gmail scopes.
//
// Who may see it is the profit area in lib/roles.js (owners), enforced per request by
// app/api/profit through lib/access.js.
import { google } from 'googleapis';

// The whole tab, not a column span: the sheet grows columns at the end, and a fixed
// A:Z once silently cut off the last five source columns.
const RANGE = 'combined_flat';
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
      printify: num(get(r, 'printify_cost')),
      printful: num(get(r, 'printful_cost')),
      gelato: num(get(r, 'gelato_cost')),
      meta: num(get(r, 'meta_spend')),
      google: num(get(r, 'google_spend')),
      fees: num(get(r, 'shopify_fees_est')),
      profit: num(get(r, 'profit')),
      // Channels: Shopify's attribution, then what Meta and Google report themselves.
      shMetaOrders: num(get(r, 'shopify_meta_orders')),
      shMetaRev: num(get(r, 'shopify_meta_revenue')),
      shGoogleOrders: num(get(r, 'shopify_google_orders')),
      shGoogleRev: num(get(r, 'shopify_google_revenue')),
      metaConv: num(get(r, 'meta_purchases')),
      metaValue: num(get(r, 'meta_purchase_value')),
      googleConv: num(get(r, 'google_conversions')),
      googleValue: num(get(r, 'google_conv_value')),
      // The other Shopify-attributed sources (see orderSource_ in the brand scripts).
      shSocialOrders: num(get(r, 'shopify_social_orders')), shSocialRev: num(get(r, 'shopify_social_revenue')),
      shSearchOrders: num(get(r, 'shopify_search_orders')), shSearchRev: num(get(r, 'shopify_search_revenue')),
      shEmailOrders: num(get(r, 'shopify_email_orders')), shEmailRev: num(get(r, 'shopify_email_revenue')),
      shReferralOrders: num(get(r, 'shopify_referral_orders')), shReferralRev: num(get(r, 'shopify_referral_revenue')),
      shDirectOrders: num(get(r, 'shopify_direct_orders')), shDirectRev: num(get(r, 'shopify_direct_revenue')),
    });
  }
  const rows = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Whether Profit Combined carries the channel columns yet; until its script is updated
  // they read as zero, which the tab must not present as "no orders from Meta".
  rows.hasChannels = 'shopify_meta_orders' in col;
  rows.hasSources = 'shopify_direct_revenue' in col;
  cache = { at: Date.now(), rows };
  return rows;
}

// --- Payload ---------------------------------------------------------------------
// The tab gets the daily rows themselves, not pre-cut periods: it does the arithmetic in
// lib/profitMath.js on the device, so toggling brands or picking a custom range is
// instant and needs no further request. Rows are trimmed to the fields that math uses.

const KEEP = ['brand', 'date', 'net', 'orders', 'printify', 'printful', 'gelato', 'meta', 'google', 'fees', 'profit',
  'shMetaOrders', 'shMetaRev', 'shGoogleOrders', 'shGoogleRev', 'metaConv', 'metaValue', 'googleConv', 'googleValue',
  'shSocialOrders', 'shSocialRev', 'shSearchOrders', 'shSearchRev', 'shEmailOrders', 'shEmailRev',
  'shReferralOrders', 'shReferralRev', 'shDirectOrders', 'shDirectRev'];

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function profitPayload(allRows) {
  const rows = allRows.map((r) => {
    const o = {};
    for (const k of KEEP) o[k] = typeof r[k] === 'number' ? Math.round(r[k] * 100) / 100 : r[k];
    return o;
  });
  return {
    today: todayIn(TZ),
    lastDate: rows.length ? rows[rows.length - 1].date : null,
    brands: [...new Set(rows.map((r) => r.brand))].sort(),
    hasChannels: !!allRows.hasChannels,
    hasSources: !!allRows.hasSources,
    rows,
  };
}
