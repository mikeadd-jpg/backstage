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

// Recent problem orders -> map of external_id (Shopify order id) -> status.
export async function listProblemOrders(storeId) {
  if (!process.env.PRINTFUL_TOKEN) return {};
  const res = await fetch(BASE + '/orders?limit=50', { headers: headers(storeId) });
  if (!res.ok) return {};
  const data = await res.json();
  const problems = {};
  for (const o of data.result || []) {
    const status = String(o.status || '').toLowerCase();
    if (/hold|fail|cancel|error|pending/.test(status)) {
      if (o.external_id) problems[String(o.external_id)] = o.status;
    }
  }
  return problems;
}
