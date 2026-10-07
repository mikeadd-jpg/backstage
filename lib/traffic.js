// Traffic and traffic quality for the Traffic tab, from each brand's own Shopify
// Analytics (ShopifyQL via lib/shopify.js), so the numbers match Shopify's Sessions and
// Conversion reports. Read-only.
//
// Per brand and date range: sessions and their funnel by channel, orders and net sales by
// the same channel (so revenue per session is real, not modelled), landing pages,
// devices, and a daily series by traffic type. Shopify cannot split sales by landing page
// or device, so those two show the funnel and conversion only.
//
// Shopify hands back bounce rate, pages per session and average duration as rates; they
// are multiplied back into totals here so that anything summed later stays correct.
// Results are cached in Postgres (insights_cache) for an hour, or a week for past ranges.
import { BRANDS, configuredShopifyBrands } from './brands.js';
import { shopifyql } from './shopify.js';
import { getInsightsCache, putInsightsCache } from './db.js';
import { blank } from './trafficMath.js';

const HOUR = 60 * 60 * 1000;
const TZ = process.env.PROFIT_TZ || 'America/New_York';

export function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
};

/** One session row (any grouping) in counts. */
function sessionCounts(r) {
  const sessions = num(r.sessions);
  return {
    ...blank(),
    sessions,
    cart: num(r.sessions_with_cart_additions),
    checkout: num(r.sessions_that_reached_checkout),
    completed: num(r.sessions_that_completed_checkout),
    bounces: num(r.bounce_rate) * sessions,
    pageviews: num(r.pageviews_per_session) * sessions,
    seconds: num(r.average_session_duration) * sessions,
  };
}

const FUNNEL = 'sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, ' +
  'bounce_rate, pageviews_per_session, average_session_duration';

async function cached(key, ttl, load) {
  const hit = await getInsightsCache(key).catch(() => null);
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < ttl) return hit.data;
  const data = await load();
  await putInsightsCache(key, data).catch(() => {});
  return data;
}

/**
 * One brand's traffic for [from, to] (inclusive, the shop's own timezone). `lite` skips
 * landing pages, devices and the daily series, which a comparison period does not need.
 */
async function brandTraffic(brand, from, to, lite) {
  const range = `SINCE ${from} UNTIL ${to}`;
  const ttl = to >= todayLocal() ? HOUR : 7 * 24 * HOUR;
  return cached(`traffic:${brand}:${from}:${to}:${lite ? 'lite' : 'full'}`, ttl, async () => {
    const q = (s) => shopifyql(brand, s);
    // Sequential: they are cheap, and a burst of six per brand is what trips Shopify's
    // cost-based throttle.
    const channelSessions = await q(`FROM sessions SHOW ${FUNNEL} GROUP BY referring_channel, traffic_type ${range} LIMIT 1000`);
    const channelSales = await q(`FROM sales SHOW orders, net_sales GROUP BY referring_channel, traffic_type ${range} LIMIT 1000`);
    const total = await q(`FROM sessions SHOW sessions, online_store_visitors ${range}`);

    const channels = new Map();
    const keyOf = (r) => (r.referring_channel || '') + '|' + (r.traffic_type || '');
    for (const r of channelSessions) {
      channels.set(keyOf(r), { channel: r.referring_channel || '', type: r.traffic_type || '', ...sessionCounts(r) });
    }
    for (const r of channelSales) {
      const k = keyOf(r);
      const e = channels.get(k) || { channel: r.referring_channel || '', type: r.traffic_type || '', ...blank() };
      e.orders += num(r.orders);
      e.sales += num(r.net_sales);
      channels.set(k, e);
    }

    const out = {
      channels: [...channels.values()],
      visitors: num(total[0] && total[0].online_store_visitors),
    };
    if (lite) return out;

    const landing = await q(`FROM sessions SHOW ${FUNNEL} GROUP BY landing_page_path ${range} ORDER BY sessions DESC LIMIT 60`);
    const devices = await q(`FROM sessions SHOW ${FUNNEL} GROUP BY session_device_type ${range} LIMIT 20`);
    const daily = await q(`FROM sessions SHOW sessions, sessions_that_completed_checkout GROUP BY traffic_type TIMESERIES day ${range} LIMIT 5000`);

    out.landing = landing.map((r) => ({ path: r.landing_page_path || '(none)', ...sessionCounts(r) }));
    out.devices = devices.map((r) => ({ device: r.session_device_type || 'unknown', ...sessionCounts(r) }));
    out.daily = daily.map((r) => ({
      date: String(r.day || '').slice(0, 10), type: r.traffic_type || 'unknown',
      sessions: num(r.sessions), completed: num(r.sessions_that_completed_checkout),
    }));
    return out;
  });
}

/** Every configured brand's traffic for the range, side by side. Errors are in-band. */
export async function trafficFor(from, to, { lite = false } = {}) {
  const brands = configuredShopifyBrands();
  return Promise.all(brands.map(async (b) => {
    try {
      return { key: b, name: BRANDS[b].name, ...(await brandTraffic(b, from, to, lite)) };
    } catch (err) {
      return { key: b, name: BRANDS[b].name, error: String(err.message || err) };
    }
  }));
}

export function trafficBrands() {
  return configuredShopifyBrands().map((b) => BRANDS[b].name);
}
