// Shopify is the source of truth. Every order flows through it regardless of who
// fulfills the item, so we read status here first and only drill into a print vendor
// when an item is still unshipped.
//
// Auth note: apps created in the Shopify Dev Dashboard (the only option since Jan 1,
// 2026) do not have a permanent shpat_ token. Instead we exchange the app's client id
// and secret for a short-lived access token via the client credentials grant, and
// cache it until just before it expires. You only store CLIENT_ID and CLIENT_SECRET.

const API_VERSION = '2026-07';

// In-memory token cache, keyed by brand: { token, expiresAt }.
const tokenCache = {};

function creds(brand) {
  const up = brand.toUpperCase();
  return {
    domain: process.env[up + '_SHOPIFY_DOMAIN'],
    clientId: process.env[up + '_SHOPIFY_CLIENT_ID'],
    clientSecret: process.env[up + '_SHOPIFY_CLIENT_SECRET'],
  };
}

async function getAccessToken(brand) {
  const cached = tokenCache[brand];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const { domain, clientId, clientSecret } = creds(brand);
  if (!domain || !clientId || !clientSecret) {
    throw new Error('Missing Shopify client credentials for brand ' + brand);
  }

  const res = await fetch('https://' + domain + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Shopify token exchange failed for ' + brand + ': ' + res.status + ' ' + text);
  }
  const data = await res.json();
  tokenCache[brand] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
  return tokenCache[brand].token;
}

async function shopify(brand, path, params = {}) {
  const { domain } = creds(brand);
  if (!domain) throw new Error('Missing Shopify domain for brand ' + brand);
  const token = await getAccessToken(brand);

  const url = new URL('https://' + domain + '/admin/api/' + API_VERSION + '/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('Shopify ' + res.status + ' for ' + path);
  return res.json();
}

// Find an order by its name (e.g. "#EE-10428") or, failing that, by customer email.
export async function findOrder(brand, { orderNumber, email }) {
  if (orderNumber) {
    const name = orderNumber.startsWith('#') ? orderNumber : '#' + orderNumber;
    const { orders } = await shopify(brand, 'orders.json', { name, status: 'any' });
    if (orders && orders.length) return orders[0];
  }
  if (email) {
    const { orders } = await shopify(brand, 'orders.json', { email, status: 'any', limit: 1 });
    if (orders && orders.length) return orders[0];
  }
  return null;
}

// List recent orders for a store (for the proactive risk scan). Includes fulfillments.
export async function listRecentOrders(brand, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { orders } = await shopify(brand, 'orders.json', {
    status: 'any',
    created_at_min: since,
    limit: 250,
  });
  return orders || [];
}

// Map a Shopify line item + its fulfillments to our normalized ledger row.
// fulfillment_service is the clean signal: "manual" means you ship it, anything else
// ("printify", "gelato", a shipping app) tells us which vendor owns it.
export function buildLedger(order) {
  const fulfillments = order.fulfillments || [];

  const byLineItem = {};
  for (const f of fulfillments) {
    for (const li of f.line_items || []) {
      byLineItem[li.id] = {
        shipmentStatus: f.shipment_status || f.status,
        tracking: (f.tracking_numbers && f.tracking_numbers[0]) || null,
        trackingUrl: (f.tracking_urls && f.tracking_urls[0]) || null,
        company: f.tracking_company || null,
      };
    }
  }

  return (order.line_items || []).map((li) => {
    const svc = (li.fulfillment_service || 'manual').toLowerCase();
    const fulfiller = svc === 'manual' ? 'you' : svc;
    const fInfo = byLineItem[li.id];

    let status;
    if (li.fulfillment_status === 'fulfilled' || (fInfo && fInfo.tracking)) status = 'shipped';
    else if (fulfiller === 'you') status = 'action';
    else status = 'production';

    return {
      lineItemId: li.id,
      name: li.title + (li.variant_title ? ' (' + li.variant_title + ')' : ''),
      sku: li.sku || null,
      quantity: li.quantity,
      fulfiller,
      status,
      tracking: fInfo ? fInfo.tracking : null,
      trackingUrl: fInfo ? fInfo.trackingUrl : null,
    };
  });
}
