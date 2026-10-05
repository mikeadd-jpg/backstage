// Printful drill-down (used by Wallspoke, which fulfills on Printful).
// Mirrors printify.js / gelato.js: production detail for unshipped items, plus a
// problem-order list for the proactive risk scan.
// Auth: a Printful private token (Bearer). Account-level tokens also send X-PF-Store-Id.

const BASE = 'https://api.printful.com';

function headers(storeId) {
  const h = { Authorization: 'Bearer ' + process.env.PRINTFUL_TOKEN };
  if (storeId) h['X-PF-Store-Id'] = String(storeId);
  return h;
}

// Look up one order by the Shopify order id, which Printful stores as external_id.
export async function getProductionStatus(shopifyOrderId, storeId) {
  if (!process.env.PRINTFUL_TOKEN) return null;
  const res = await fetch(BASE + '/orders/@' + encodeURIComponent(shopifyOrderId), { headers: headers(storeId) });
  if (!res.ok) return null;
  const data = await res.json();
  const o = data.result;
  if (!o) return null;
  return {
    vendor: 'printful',
    status: o.status, // draft, pending, onhold, inprocess, partial, fulfilled, canceled, failed
    shipments: (o.shipments || []).map((s) => ({ carrier: s.carrier, tracking: s.tracking_number })),
    link: 'https://www.printful.com/dashboard/orders',
  };
}

// Problem orders from the last sinceDays -> map of external_id (Shopify order id) ->
// status. Pages back to the cutoff rather than reading one page, the same fix as
// printify.js. "draft" counts: a draft was never submitted, so nothing is being made
// until someone confirms it, and the risk scan decides how old a draft has to be.
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // runaway guard: 2000 orders

export async function listProblemOrders(storeId, sinceDays = 30) {
  if (!process.env.PRINTFUL_TOKEN) return {};
  const cutoff = Date.now() - sinceDays * 86400000;
  const problems = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(BASE + '/orders?limit=' + PAGE_SIZE + '&offset=' + page * PAGE_SIZE, {
      headers: headers(storeId),
    });
    if (!res.ok) throw new Error('Printful ' + res.status + ' listing orders');
    const data = await res.json();
    const orders = data.result || [];
    for (const o of orders) {
      if (o.created && o.created * 1000 < cutoff) return problems;
      const status = String(o.status || '').toLowerCase();
      if (o.external_id && /draft|hold|fail|cancel|error|pending/.test(status)) {
        problems[String(o.external_id)] = o.status;
      }
    }
    const total = data.paging ? data.paging.total : 0;
    if (orders.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) break;
  }
  return problems;
}
