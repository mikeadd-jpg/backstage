// Pure P&L arithmetic shared by the server (lib/profit.js) and the Profit tab. No I/O and
// no Node imports, so the browser can run it: the tab fetches the daily rows once and
// recomputes on every brand toggle or date change without another request.
//
// Every window is inclusive on both ends, and the preset windows end TODAY, with today
// still in progress, because that is how the sheets' own dashboards count and it is what
// makes the two agree to the cent.

// Cost lines, in display order. Each is a combined_flat column. "Other" is derived:
// whatever separates net revenue minus profit from the itemised lines, e.g. old Elder Emo
// rows whose profit was typed in by hand. It is shown, never hidden.
export const COST_LINES = [
  { key: 'printify', label: 'Printify', group: 'Production' },
  { key: 'printful', label: 'Printful', group: 'Production' },
  { key: 'gelato', label: 'Gelato', group: 'Production' },
  { key: 'meta', label: 'Meta ads', group: 'Advertising' },
  { key: 'google', label: 'Google ads', group: 'Advertising' },
  { key: 'fees', label: 'Shopify fees (est.)', group: 'Fees' },
  { key: 'other', label: 'Other / not itemised', group: 'Other' },
];

const FIELDS = ['net', 'orders', 'printify', 'printful', 'gelato', 'meta', 'google', 'fees', 'profit',
  'shMetaOrders', 'shMetaRev', 'shGoogleOrders', 'shGoogleRev', 'metaConv', 'metaValue', 'googleConv', 'googleValue'];

// Ad channels compared two ways: what Shopify credits to the channel (the visit that
// placed the order) and what the platform claims for itself (Meta: 7-day click + 1-day
// view; Google: primary "Conversions"). Google here is paid clicks only, so organic search
// never flatters ad CPA. Columns come from the brand sheets; see sheets/ in CLAUDE.md.
export const CHANNELS = [
  { key: 'meta', label: 'Meta', platform: 'Meta reports', spend: 'meta',
    shOrders: 'shMetaOrders', shRev: 'shMetaRev', pConv: 'metaConv', pValue: 'metaValue',
    window: '7-day click + 1-day view' },
  { key: 'google', label: 'Google Ads', platform: 'Google reports', spend: 'google',
    shOrders: 'shGoogleOrders', shRev: 'shGoogleRev', pConv: 'googleConv', pValue: 'googleValue',
    window: 'primary conversions' },
];

/** Spend, Shopify-side and platform-side orders/revenue/CPA/ROAS, and the gap, for one channel. */
export function channelStats(t, ch) {
  const spend = t[ch.spend];
  const side = (orders, revenue) => ({
    orders, revenue,
    cpa: orders ? spend / orders : null,
    roas: spend ? revenue / spend : null,
  });
  const shopify = side(t[ch.shOrders], t[ch.shRev]);
  const platform = side(t[ch.pConv], t[ch.pValue]);
  return {
    spend, shopify, platform,
    // >1 means the platform claims more than Shopify gives it; <1 that it claims less,
    // which usually means its conversion tracking is missing purchases.
    orderGap: shopify.orders ? platform.orders / shopify.orders : null,
    revenueGap: shopify.revenue ? platform.revenue / shopify.revenue : null,
  };
}

/** First date any channel column is non-zero, i.e. how far back the channel history reaches. */
export function channelStart(rows) {
  let first = null;
  for (const r of rows) {
    if (first && r.date >= first) continue;
    if (r.shMetaOrders || r.shGoogleOrders || r.metaConv || r.googleConv) first = r.date;
  }
  return first;
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
}
function shiftMonth(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

function blank() {
  const t = {};
  for (const f of FIELDS) t[f] = 0;
  return t;
}
function finish(t) {
  t.cogs = t.printify + t.printful + t.gelato;
  t.ads = t.meta + t.google;
  t.costs = t.net - t.profit;
  const itemised = t.cogs + t.ads + t.fees;
  // Rounding in the sheets leaves sub-cent dust; only a real gap counts as "other".
  t.other = Math.abs(t.costs - itemised) < 0.01 ? 0 : t.costs - itemised;
  t.margin = t.net ? t.profit / t.net : null;
  t.mer = t.ads ? t.net / t.ads : null;
  t.perOrder = t.orders ? t.profit / t.orders : null;
  return t;
}

/** Totals over [from, to] for the chosen brands, overall and per brand. */
export function totals(rows, brands, from, to) {
  const all = blank();
  const byBrand = {};
  for (const b of brands) byBrand[b] = blank();
  for (const r of rows) {
    if (r.date < from || r.date > to || !(r.brand in byBrand)) continue;
    for (const f of FIELDS) { all[f] += r[f]; byBrand[r.brand][f] += r[f]; }
  }
  for (const b of brands) finish(byBrand[b]);
  return { ...finish(all), byBrand };
}

/** One row per date over [from, to] for the chosen brands, brands summed together. */
export function dailySeries(rows, brands, from, to) {
  const set = new Set(brands);
  const map = new Map();
  for (const r of rows) {
    if (r.date < from || r.date > to || !set.has(r.brand)) continue;
    let d = map.get(r.date);
    if (!d) { d = { date: r.date, ...blank() }; map.set(r.date, d); }
    for (const f of FIELDS) d[f] += r[f];
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map(finish);
}

/** The preset windows, each with the window it is compared against. */
export function presetPeriods(today) {
  const yesterday = addDays(today, -1);
  const monthStart = today.slice(0, 8) + '01';
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  return [
    { key: 'today', label: 'Today', from: today, to: today, compare: null, compareLabel: 'in progress' },
    { key: 'yesterday', label: 'Yesterday', from: yesterday, to: yesterday,
      compare: { from: addDays(today, -2), to: addDays(today, -2) }, compareLabel: 'vs. day before' },
    { key: '7d', label: '7 days', from: addDays(today, -6), to: today,
      compare: { from: addDays(today, -13), to: addDays(today, -7) }, compareLabel: 'vs. prior 7 days' },
    { key: '30d', label: '30 days', from: addDays(today, -29), to: today,
      compare: { from: addDays(today, -59), to: addDays(today, -30) }, compareLabel: 'vs. prior 30 days' },
    { key: 'mtd', label: 'Month', from: monthStart, to: today,
      compare: { from: shiftMonth(monthStart, -1), to: shiftMonth(today, -1) }, compareLabel: 'vs. same days last month' },
    { key: 'ytd', label: 'Year', from: today.slice(0, 4) + '-01-01', to: today,
      compare: { from: lastYear + '-01-01', to: lastYear + today.slice(4) }, compareLabel: 'vs. same span last year' },
  ];
}

/** A custom window, compared with the same number of days immediately before it. */
export function customPeriod(from, to) {
  const n = daysBetween(from, to);
  return {
    key: 'custom', label: 'Custom', from, to,
    compare: { from: addDays(from, -n), to: addDays(from, -1) },
    compareLabel: 'vs. the ' + n + ' day' + (n === 1 ? '' : 's') + ' before',
  };
}

/** First date each brand has a row, so a comparison reaching past it can be flagged. */
export function firstDates(rows) {
  const out = {};
  for (const r of rows) if (!out[r.brand] || r.date < out[r.brand]) out[r.brand] = r.date;
  return out;
}
