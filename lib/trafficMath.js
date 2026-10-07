// Pure traffic arithmetic shared by the server (lib/traffic.js) and the Traffic tab. No
// I/O and no Node imports, so the browser can run it.
//
// Shopify labels each session with a referring channel (google, instagram, klaviyo, a
// site name...) and a traffic type (paid, organic, direct, unknown). Those pairs are too
// many to read, so they are grouped below; the tab can always open a group to see them.
//
// Every rate is rebuilt from counts so that groups, brands and days add up honestly:
// Shopify returns bounce rate, pages per session and average duration per row, and the
// server turns them back into totals (rate x sessions) before anything is summed.

const SEARCH = new Set(['google', 'bing', 'duckduckgo', 'brave', 'ecosia', 'yahoo', 'baidu', 'yandex', 'startpage', 'qwant', 'naver', 'aol']);
const SOCIAL = new Set(['facebook', 'instagram', 'meta', 'internalfb', 'tiktok', 'pinterest', 'reddit', 'youtube', 'twitter', 'x',
  'threads', 'snapchat', 'linkedin', 'tumblr', 'linktr', 'linktree', 'discord', 'bluesky']);
const EMAIL = new Set(['klaviyo', 'email', 'attentive', 'postscript', 'shopify_email', 'omnisend', 'mailchimp', 'sms']);
const AI = new Set(['chatgpt', 'chatgpt.com', 'openai', 'perplexity', 'gemini', 'claude', 'copilot']);

// Display order, labels and fixed colours (colour follows the group, never its rank).
export const GROUPS = [
  { key: 'paid_social',    label: 'Paid social',    color: '#2a78d6' },
  { key: 'paid_search',    label: 'Paid search',    color: '#eb6834' },
  { key: 'paid_other',     label: 'Other paid',     color: '#9a6b00' },
  { key: 'organic_search', label: 'Organic search', color: '#eda100' },
  { key: 'organic_social', label: 'Organic social', color: '#1baf7a' },
  { key: 'email',          label: 'Email and SMS',  color: '#e87ba4' },
  { key: 'ai',             label: 'AI assistants',  color: '#0e9aa7' },
  { key: 'referral',       label: 'Referral',       color: '#008300' },
  { key: 'direct',         label: 'Direct',         color: '#4a3aa7' },
  { key: 'unattributed',   label: 'Unattributed',   color: '#8c8c8c' },
  // Orders Shopify ties to no storefront session (draft orders, the Shop app, imports).
  { key: 'none',           label: 'Not from a store session', color: '#c4c4c4' },
];
export const GROUP_BY_KEY = Object.fromEntries(GROUPS.map((g) => [g.key, g]));

/** Which group a Shopify (referring_channel, traffic_type) pair belongs to. */
export function groupOf(channel, type) {
  const ch = String(channel || '').toLowerCase().trim();
  const t = String(type || '').toLowerCase().trim();
  if (!ch && !t) return 'none';
  if (ch === 'direct' || t === 'direct') return ch === 'unattributed' ? 'unattributed' : 'direct';
  if (ch === 'unattributed' || !ch) return 'unattributed';
  // Meta's {{site_source_name}} URL macro left unfilled by an ad: still a Meta ad click.
  if (ch.includes('site_source_name')) return 'paid_social';
  if (EMAIL.has(ch)) return 'email';
  if (AI.has(ch)) return 'ai';
  if (t === 'paid') return SEARCH.has(ch) ? 'paid_search' : SOCIAL.has(ch) ? 'paid_social' : 'paid_other';
  if (SEARCH.has(ch)) return 'organic_search';
  if (SOCIAL.has(ch)) return 'organic_social';
  return 'referral';
}

// The counts every row carries. bounces, pageviews and seconds are rebuilt totals.
export const COUNTS = ['sessions', 'cart', 'checkout', 'completed', 'bounces', 'pageviews', 'seconds', 'orders', 'sales'];

export function blank() {
  return Object.fromEntries(COUNTS.map((k) => [k, 0]));
}
export function add(into, row) {
  for (const k of COUNTS) into[k] += Number(row[k]) || 0;
  return into;
}

const ratio = (n, d) => (d ? n / d : null);

/** Rates from counts. Conversion is Shopify's: sessions that completed checkout. */
export function rates(t) {
  return {
    cartRate: ratio(t.cart, t.sessions),
    checkoutRate: ratio(t.checkout, t.sessions),
    convRate: ratio(t.completed, t.sessions),
    bounceRate: ratio(t.bounces, t.sessions),
    pagesPerSession: ratio(t.pageviews, t.sessions),
    avgSeconds: ratio(t.seconds, t.sessions),
    revPerSession: ratio(t.sales, t.sessions),
    aov: ratio(t.sales, t.orders),
  };
}

/** Channel rows (already merged across brands or not) grouped, each group with its rows. */
export function groupChannels(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = groupOf(r.channel, r.type);
    let e = map.get(g);
    if (!e) { e = { key: g, ...GROUP_BY_KEY[g], ...blank(), rows: [] }; map.set(g, e); }
    add(e, r);
    e.rows.push(r);
  }
  return GROUPS.map((g) => map.get(g.key)).filter(Boolean);
}

/** Rows for the chosen brands with the same dimension values merged. */
export function mergeRows(byBrand, brands, keyOf) {
  const map = new Map();
  for (const b of brands) {
    for (const r of byBrand[b] || []) {
      const k = keyOf(r);
      let e = map.get(k);
      if (!e) { e = { ...r, ...blank(), brands: [] }; map.set(k, e); }
      add(e, r);
      e.brands.push(b);
    }
  }
  return [...map.values()];
}
