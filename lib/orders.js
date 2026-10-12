// The newest orders per brand with where they came from, for the Orders tab: the UTM
// parameters and landing page of the visits Shopify links to each order, Shopify's own
// source for those visits, the sales channel that took the order, and the bucket the
// profit sheets' source rule (sheets/pp-pnl orderSource_) puts it in, so a row here can be
// checked against the Attribution tab. Read-only, and no customer fields.
import { BRANDS, configuredShopifyBrands } from './brands.js';
import { listOrdersWithJourney, shopHandle, shopPrimaryUrl } from './shopify.js';

export const ORDER_LIMIT = 50;

/** Query parameters of a URL, lower-cased keys, first value wins. */
function params(url) {
  const q = {};
  if (!url) return q;
  try {
    new URL(url, 'https://x.invalid').searchParams.forEach((v, k) => {
      const key = k.toLowerCase();
      if (!(key in q)) q[key] = v;
    });
  } catch { /* not a URL; no parameters */ }
  return q;
}

function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * The profit sheets' source rule, ported from orderSource_ in sheets/pp-pnl. Keep the two
 * in step: the sheet is what Attribution reads. `own` is the store's own hosts and brand
 * labels, since a referral from your own site is Direct.
 */
function sheetSource(landing, referrer, own) {
  const q = Object.fromEntries(Object.entries(params(landing)).map(([k, v]) => [k, v.toLowerCase()]));
  let host = hostOf(referrer);
  if (host && (own.hosts.some((d) => host === d || host.endsWith('.' + d)) || host.split('.').some((l) => own.names.includes(l)))) host = '';
  const src = q.utm_source || '';
  const med = q.utm_medium || '';
  if (/^(email|e-mail|sms|newsletter|mms)$/.test(med) || /^(klaviyo|attentive|postscript|omnisend|mailchimp|shopify_email|email|sms)$/.test(src)) return 'email';
  if ('gclid' in q || 'gbraid' in q || 'wbraid' in q || (src === 'google' && /cpc|paid|ppc/.test(med))) return 'google';
  const metaSrc = /^(facebook|fb|ig|instagram|meta|face)$/.test(src) || src.includes('site_source_name');
  if (metaSrc) return (!med || /paid|cpc|ppc|^ads?$/.test(med)) ? 'meta' : 'social';
  if ('fbclid' in q || /(^|\.)(facebook|instagram|fb)\.com$/.test(host)) return 'social';
  if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex)\.[a-z.]+$/.test(host) || /(^|\.)search\.brave\.com$/.test(host) ||
      /^(google|bing|duckduckgo|yahoo)$/.test(src)) return 'search';
  if (src || host) return 'referral';
  return 'direct';
}

/** The store's own hosts and brand labels, as the sheet works them out from shop.json. */
async function ownSite(brand) {
  const domain = (process.env[brand.toUpperCase() + '_SHOPIFY_DOMAIN'] || '').toLowerCase();
  const site = { hosts: [domain].filter(Boolean), names: [] };
  const primary = hostOf(await shopPrimaryUrl(brand).catch(() => ''));
  if (primary) {
    site.hosts.push(primary);
    const label = primary.split('.').find((l) => !/^(www|shop|store|m)$/.test(l));
    if (label) site.names.push(label);
  }
  return site;
}

/** A visit's UTMs: Shopify's parsed ones, else read off the landing page. */
function visitOut(v) {
  if (!v) return null;
  const p = params(v.landingPage);
  const u = v.utmParameters || {};
  const utm = {
    source: u.source || p.utm_source || '',
    medium: u.medium || p.utm_medium || '',
    campaign: u.campaign || p.utm_campaign || '',
    content: u.content || p.utm_content || '',
    term: u.term || p.utm_term || '',
  };
  const clickIds = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid'].filter((k) => k in p);
  return {
    source: v.source || '', sourceType: v.sourceType || '', description: v.sourceDescription || '',
    landing: v.landingPage || '', referrer: v.referrerUrl || '', at: v.occurredAt || null,
    utm, clickIds,
  };
}

function orderOut(o, handle, own) {
  const j = o.customerJourneySummary || {};
  const first = visitOut(j.firstVisit), last = visitOut(j.lastVisit);
  const ch = (o.channelInformation && o.channelInformation.channelDefinition) || {};
  const money = (o.currentTotalPriceSet && o.currentTotalPriceSet.shopMoney) || {};
  const id = String(o.id).split('/').pop();
  return {
    id, name: o.name, createdAt: o.createdAt, cancelled: !!o.cancelledAt,
    financial: o.displayFinancialStatus || '',
    total: parseFloat(money.amount) || 0, currency: money.currencyCode || 'USD',
    // Which sales channel took the order: Shopify's sourceName ("web", "shopify_draft_order",
    // an app id) plus the friendlier channel and app names when it has them.
    sourceName: o.sourceName || '',
    channel: [ch.channelName, ch.subChannelName].filter(Boolean).join(' · ') || (o.app && o.app.name) || '',
    journeyReady: j.ready !== false, daysToConversion: j.daysToConversion ?? null,
    first, last,
    // The sheet reads the order's landing_site and referring_site, which are its last visit.
    sheetSource: sheetSource(last && last.landing, last && last.referrer, own),
    adminUrl: handle ? `https://admin.shopify.com/store/${handle}/orders/${id}` : null,
  };
}

/** Every configured brand's newest orders in [from, to], side by side. Errors are in-band. */
export async function recentOrdersFor(from, to) {
  return Promise.all(configuredShopifyBrands().map(async (b) => {
    const name = BRANDS[b].name;
    try {
      const [orders, own] = await Promise.all([listOrdersWithJourney(b, from, to, ORDER_LIMIT), ownSite(b)]);
      return { key: b, name, orders: orders.map((o) => orderOut(o, shopHandle(b), own)) };
    } catch (err) {
      return { key: b, name, error: String(err.message || err) };
    }
  }));
}

export function orderBrands() {
  return configuredShopifyBrands().map((b) => BRANDS[b].name);
}
