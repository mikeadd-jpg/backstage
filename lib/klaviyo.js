// Klaviyo, read-only, for the Email tab: how many people each brand can email, how that
// number moves, and how each flow performs. Every brand is its own Klaviyo account with
// its own private key, <BRAND>_KLAVIYO_API_KEY, scoped read-only (accounts, segments,
// metrics, flows). Nothing here writes to Klaviyo.
//
// Three facts about the API shape everything below:
//   - The flow report allows 2 requests a minute and 225 a day per account. Every answer
//     is cached in Postgres (klaviyo_cache), and when Klaviyo refuses, a stale copy is
//     served rather than an error.
//   - Klaviyo answers "how many subscribers now" but keeps no history of that number, so
//     growth over time is built from the subscribe and unsubscribe events, and the count
//     itself is written down daily (email_list_snapshots) from the day this shipped.
//   - Metric aggregates take at most one year per query and read their datetime filter as
//     UTC, with `timezone` deciding only the bucketing. Ranges are therefore chunked and
//     passed as the UTC instant of each local midnight.
import { BRANDS } from './brands.js';
import { getKlaviyoCache, putKlaviyoCache, upsertListSnapshot } from './db.js';

const BASE = 'https://a.klaviyo.com/api';
const REVISION = process.env.KLAVIYO_REVISION || '2026-07-15';

const HOUR = 60 * 60 * 1000;
const META_TTL = 24 * HOUR;     // account timezone, segment and metric ids barely change
const COUNT_TTL = HOUR;
const GROWTH_TTL = HOUR;
const GROWTH_DAYS = 730;        // enough for the Year preset's comparison with last year
const MAX_FLOW_DAYS = 365;      // Klaviyo's own ceiling for one report

// Consent events. A profile can also stop being emailable by bouncing or being suppressed,
// which these do not count, so the live total is the authority and these are the motion.
const SUBSCRIBED = 'Subscribed to Email Marketing';
const UNSUBSCRIBED = 'Unsubscribed from Email Marketing';

export function klaviyoKey(brand) {
  return process.env[brand.toUpperCase() + '_KLAVIYO_API_KEY'] || null;
}

/** Brand keys in BRANDS order, each with whether a key is configured. */
export function klaviyoBrands() {
  return Object.keys(BRANDS).map((key) => ({ key, name: BRANDS[key].name, configured: !!klaviyoKey(key) }));
}

class KlaviyoError extends Error {
  constructor(message, { status, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function kfetch(brand, path, { method = 'GET', body } = {}) {
  const key = klaviyoKey(brand);
  if (!key) throw new KlaviyoError(`${brand.toUpperCase()}_KLAVIYO_API_KEY is not set`);
  const res = await fetch(path.startsWith('http') ? path : BASE + path, {
    method,
    headers: {
      Authorization: 'Klaviyo-API-Key ' + key,
      revision: REVISION,
      accept: 'application/vnd.api+json',
      ...(body ? { 'content-type': 'application/vnd.api+json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.ok) return res.json();

  const text = await res.text();
  let detail = text.slice(0, 300);
  try { detail = JSON.parse(text).errors?.map((e) => e.detail || e.title).join('; ') || detail; } catch { /* not JSON */ }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60;
    throw new KlaviyoError('Klaviyo rate limit', { status: 429, retryAfter });
  }
  if (res.status === 401) throw new KlaviyoError('Klaviyo rejected the API key. Check ' + brand.toUpperCase() + '_KLAVIYO_API_KEY.', { status: 401 });
  if (res.status === 403) throw new KlaviyoError('The Klaviyo key is missing a read scope (needs accounts, segments, metrics and flows read): ' + detail, { status: 403 });
  throw new KlaviyoError(`Klaviyo ${res.status}: ${detail}`, { status: res.status });
}

/** Every page of a GET list endpoint. */
async function kfetchAll(brand, path, maxPages = 30) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < maxPages; i++) {
    const page = await kfetch(brand, next);
    out.push(...(page.data || []));
    next = page.links && page.links.next;
  }
  return out;
}

/** Fresh cache value, or run `load` and store it. Rate-limited loads fall back to stale. */
async function cached(key, ttl, load) {
  const hit = await getKlaviyoCache(key).catch(() => null);
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < ttl) return { data: hit.data, fetchedAt: hit.fetchedAt };
  try {
    const data = await load();
    await putKlaviyoCache(key, data).catch(() => {});
    return { data, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (hit) return { data: hit.data, fetchedAt: hit.fetchedAt, stale: true, staleReason: err.message };
    throw err;
  }
}

// ----- dates in the account's own timezone -----

function tzOffsetMs(tz, utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/** The UTC instant of local midnight starting `iso` (YYYY-MM-DD) in `tz`. */
function localMidnight(iso, tz) {
  const guess = Date.parse(iso + 'T00:00:00Z');
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);   // second pass settles DST edges
  return new Date(t);
}
export function localToday(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function localDate(utcIso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcIso));
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
}
const noMillis = (d) => d.toISOString().replace(/\.\d{3}Z$/, '');

// ----- account metadata: timezone, the subscriber segment, metric ids -----

/**
 * The segment that defines the list: a single condition on email marketing consent. The
 * count is every emailable profile, i.e. "can receive email marketing" with subscription =
 * any (Klaviyo's usual "All Emailable Profiles"), which includes people who never opted in
 * but may still be emailed. That is the owner's chosen definition, the same in every brand.
 * A subscribed-only segment is used only if no emailable one exists, and the tab says so.
 * <BRAND>_KLAVIYO_SEGMENT_ID overrides the search.
 */
function consentKind(seg) {
  const groups = seg.attributes?.definition?.condition_groups || [];
  if (groups.length !== 1 || groups[0].conditions?.length !== 1) return null;
  const c = groups[0].conditions[0];
  if (c.type !== 'profile-marketing-consent' || c.consent?.channel !== 'email' || c.consent?.can_receive_marketing !== true) return null;
  const sub = c.consent?.consent_status?.subscription;
  if (c.consent?.consent_status?.filters) return null;
  return sub === 'subscribed' ? 'subscribed' : sub === 'any' ? 'emailable' : null;
}

async function accountMeta(brand) {
  return cached('meta:' + brand, META_TTL, async () => {
    const [account, metrics] = await Promise.all([
      kfetch(brand, '/accounts?fields[account]=timezone'),
      kfetchAll(brand, '/metrics?fields[metric]=name,integration'),
    ]);
    const tz = account.data?.[0]?.attributes?.timezone || 'America/New_York';

    const byName = (name, integration) => {
      const all = metrics.filter((m) => m.attributes?.name === name);
      return (all.find((m) => !integration || m.attributes?.integration?.key === integration) || all[0] || {}).id || null;
    };

    let segment = null;
    const override = process.env[brand.toUpperCase() + '_KLAVIYO_SEGMENT_ID'];
    if (override) {
      const s = await kfetch(brand, `/segments/${override}?fields[segment]=name,definition`);
      segment = { id: s.data.id, name: s.data.attributes.name, kind: consentKind(s.data) || 'custom' };
    } else {
      const segs = await kfetchAll(brand, '/segments?fields[segment]=name,definition,is_active');
      const found = segs
        .filter((s) => s.attributes?.is_active !== false)
        .map((s) => ({ id: s.id, name: s.attributes.name, kind: consentKind(s) }))
        .filter((s) => s.kind);
      segment = found.find((s) => s.kind === 'emailable') || found.find((s) => s.kind === 'subscribed') || null;
    }

    return {
      tz,
      segment,
      metrics: {
        subscribed: byName(SUBSCRIBED),
        unsubscribed: byName(UNSUBSCRIBED),
        placedOrder: byName('Placed Order', 'shopify'),
      },
    };
  });
}

// ----- subscribers: the live count, and the daily motion -----

async function subscriberCount(brand, meta) {
  if (!meta.segment) return null;
  const res = await cached('count:' + brand, COUNT_TTL, async () => {
    const s = await kfetch(brand, `/segments/${meta.segment.id}?additional-fields[segment]=profile_count&fields[segment]=name`);
    return { count: s.data.attributes.profile_count };
  });
  // Written on every read, so the history fills in even on days the cron misses.
  if (!res.stale && res.data.count != null) {
    await upsertListSnapshot(brand, localToday(meta.tz), res.data.count, meta.segment.id).catch(() => {});
  }
  return res;
}

/** Daily counts of one metric over [from, to] local, chunked under Klaviyo's 1 year cap. */
async function dailyCounts(brand, metricId, from, to, tz) {
  const out = {};
  if (!metricId) return out;
  for (let start = from; start <= to; start = addDays(start, 360)) {
    const end = [addDays(start, 359), to].sort()[0];
    const res = await kfetch(brand, '/metric-aggregates', {
      method: 'POST',
      body: { data: { type: 'metric-aggregate', attributes: {
        metric_id: metricId, measurements: ['count'], interval: 'day', timezone: tz,
        filter: [
          `greater-or-equal(datetime,${noMillis(localMidnight(start, tz))})`,
          `less-than(datetime,${noMillis(localMidnight(addDays(end, 1), tz))})`,
        ],
      } } },
    });
    const a = res.data.attributes;
    const counts = (a.data && a.data[0] && a.data[0].measurements.count) || [];
    a.dates.forEach((d, i) => {
      const day = localDate(d, tz);
      if (day >= start && day <= end) out[day] = (out[day] || 0) + (counts[i] || 0);
    });
  }
  return out;
}

async function growth(brand, meta) {
  const to = localToday(meta.tz);
  const from = addDays(to, -(GROWTH_DAYS - 1));
  return cached('growth:' + brand, GROWTH_TTL, async () => {
    const [subs, unsubs] = [
      await dailyCounts(brand, meta.metrics.subscribed, from, to, meta.tz),
      await dailyCounts(brand, meta.metrics.unsubscribed, from, to, meta.tz),
    ];
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (subs[d] || unsubs[d]) days.push({ date: d, subscribed: subs[d] || 0, unsubscribed: unsubs[d] || 0 });
    }
    return { from, to, days };
  });
}

/** Everything the list half of the tab needs for one brand. Errors are in-band. */
export async function brandList(brand) {
  const name = BRANDS[brand].name;
  if (!klaviyoKey(brand)) return { key: brand, name, configured: false };
  try {
    const meta = (await accountMeta(brand)).data;
    const [count, g] = await Promise.all([subscriberCount(brand, meta), growth(brand, meta)]);
    return {
      key: brand, name, configured: true, tz: meta.tz,
      segment: meta.segment,
      subscribers: count ? count.data.count : null,
      countAt: count ? count.fetchedAt : null,
      growthFrom: g.data.from,
      days: g.data.days,
      missingMetrics: [!meta.metrics.subscribed && SUBSCRIBED, !meta.metrics.unsubscribed && UNSUBSCRIBED].filter(Boolean),
      stale: !!((count && count.stale) || g.stale),
    };
  } catch (err) {
    return { key: brand, name, configured: true, error: err.message };
  }
}

/** Record today's count for every configured brand. Run daily by /api/email-snapshot. */
export async function snapshotAll() {
  const out = [];
  for (const b of klaviyoBrands().filter((x) => x.configured)) {
    try {
      const meta = (await accountMeta(b.key)).data;
      const c = await subscriberCount(b.key, meta);
      out.push({ brand: b.key, subscribers: c ? c.data.count : null, segment: meta.segment && meta.segment.name });
    } catch (err) {
      out.push({ brand: b.key, error: err.message });
    }
  }
  return out;
}

// ----- flows -----

// Counts only; every rate is computed after summing, so a flow's rate is weighted by its
// messages the way Klaviyo's own flow overview is.
const FLOW_STATS = ['recipients', 'delivered', 'opens_unique', 'clicks_unique', 'conversions', 'conversion_uniques',
  'conversion_value', 'unsubscribe_uniques', 'bounced', 'spam_complaints'];

function blankStats() {
  return Object.fromEntries(FLOW_STATS.map((k) => [k, 0]));
}
function addStats(into, s) {
  for (const k of FLOW_STATS) into[k] += Number(s[k]) || 0;
}

/**
 * Flow performance for [from, to] (local dates, inclusive), one entry per flow with its
 * messages. Attribution and uniqueness are Klaviyo's, by send date, so the numbers match
 * the flow pages in Klaviyo for the same dates.
 */
export async function brandFlows(brand, from, to) {
  const name = BRANDS[brand].name;
  if (!klaviyoKey(brand)) return { key: brand, name, configured: false };
  try {
    const meta = (await accountMeta(brand)).data;
    if (!meta.metrics.placedOrder) return { key: brand, name, configured: true, error: 'No Placed Order metric in this Klaviyo account, so flows have nothing to convert on.' };

    let clampedFrom = from;
    if (daysBetween(from, to) > MAX_FLOW_DAYS) clampedFrom = addDays(to, -(MAX_FLOW_DAYS - 1));
    const today = localToday(meta.tz);
    // Past ranges never change; anything touching today goes stale within the hour.
    const ttl = to >= today ? HOUR : 7 * 24 * HOUR;

    const res = await cached(`flows:${brand}:${clampedFrom}:${to}`, ttl, async () => {
      const [report, flows] = await Promise.all([
        kfetch(brand, '/flow-values-reports', {
          method: 'POST',
          body: { data: { type: 'flow-values-report', attributes: {
            statistics: FLOW_STATS,
            timeframe: { start: localMidnight(clampedFrom, meta.tz).toISOString(), end: localMidnight(addDays(to, 1), meta.tz).toISOString() },
            conversion_metric_id: meta.metrics.placedOrder,
            group_by: ['flow_id', 'flow_name', 'flow_message_id', 'flow_message_name', 'send_channel'],
          } } },
        }),
        kfetchAll(brand, '/flows?fields[flow]=name,status,archived,trigger_type'),
      ]);
      const info = Object.fromEntries(flows.map((f) => [f.id, f.attributes]));
      const byFlow = new Map();
      for (const r of report.data.attributes.results || []) {
        const g = r.groupings;
        let f = byFlow.get(g.flow_id);
        if (!f) {
          const fi = info[g.flow_id] || {};
          f = { id: g.flow_id, name: g.flow_name || fi.name || g.flow_id, status: fi.archived ? 'archived' : (fi.status || 'unknown'),
            trigger: fi.trigger_type || null, ...blankStats(), messages: [] };
          byFlow.set(g.flow_id, f);
        }
        const m = { id: g.flow_message_id, name: g.flow_message_name || g.flow_message_id, channel: g.send_channel, ...blankStats() };
        addStats(m, r.statistics);
        addStats(f, r.statistics);
        f.messages.push(m);
      }
      return { flows: [...byFlow.values()], truncated: !!(report.links && report.links.next) };
    });

    return {
      key: brand, name, configured: true, from: clampedFrom, to, clamped: clampedFrom !== from,
      flows: res.data.flows, truncated: res.data.truncated, fetchedAt: res.fetchedAt,
      stale: !!res.stale,
    };
  } catch (err) {
    if (err.status === 429) return { key: brand, name, configured: true, rateLimited: true, retryAfter: err.retryAfter };
    return { key: brand, name, configured: true, error: err.message };
  }
}
