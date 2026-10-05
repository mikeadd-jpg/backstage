// Printify drill-down. Only called for line items Shopify shows as unshipped print
// products, to add production detail Shopify does not carry.
// Printify stores the originating Shopify order id on each order, so we match on that.
//
// Printify has no lookup by Shopify order id, so everything here pages through the
// shop's order list, newest first. Elder Emo runs about 350 Printify orders a month, so
// a single page of 50 covers only the last few days; anything older used to be
// invisible. Pages are followed back to a date cutoff instead.

const PAGE_SIZE = 50;
const MAX_PAGES = 20; // runaway guard: 1000 orders

// Yields the shop's orders newest first, stopping once they are older than sinceDays.
// Throws on a failed page so callers can tell "no problems" from "could not look".
async function* recentOrders(shopId, sinceDays) {
  const token = process.env.PRINTIFY_TOKEN;
  if (!token || !shopId) return;
  const cutoff = Date.now() - sinceDays * 86400000;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      'https://api.printify.com/v1/shops/' + shopId + '/orders.json?limit=' + PAGE_SIZE + '&page=' + page,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    if (!res.ok) throw new Error('Printify ' + res.status + ' listing orders');
    const data = await res.json();
    const orders = data.data || [];
    for (const o of orders) {
      if (new Date(o.created_at).getTime() < cutoff) return;
      yield o;
    }
    if (!orders.length || !data.next_page_url) return;
  }
}

export async function getProductionStatus(shopId, shopifyOrderId) {
  let match = null;
  try {
    for await (const o of recentOrders(shopId, 60)) {
      if (String(o.metadata && o.metadata.shop_order_id) === String(shopifyOrderId)) { match = o; break; }
    }
  } catch { return null; }
  if (!match) return null;

  return {
    vendor: 'printify',
    status: match.status, // on-hold, in-production, fulfilled, canceled, etc.
    shipments: (match.shipments || []).map((s) => ({ carrier: s.carrier, tracking: s.number })),
    // Per-order deep links are not stable; link to the orders list (searchable by number).
    link: 'https://printify.com/app/orders',
  };
}

// What the risk scan needs from Printify for the last sinceDays, keyed by Shopify order:
//   problems:  Shopify order id -> Printify status, for anything that looks like trouble
//              (on hold, has issue, canceled...). Substring matching keeps this robust to
//              exact Printify status naming.
//   delivered: tracking numbers Printify has seen delivered. Printify follows the parcel
//              itself, and keeps following after Shopify's carrier feed goes quiet, so
//              this is a second opinion on Shopify's shipment_status.
export async function listRecentOrderSignals(shopId, sinceDays = 30) {
  const problems = {};
  const delivered = new Set();
  for await (const o of recentOrders(shopId, sinceDays)) {
    const status = String(o.status || '').toLowerCase();
    const sid = o.metadata && o.metadata.shop_order_id;
    if (sid && /hold|issue|cancel|declin|error|action|not-received|failed/.test(status)) {
      problems[String(sid)] = o.status;
    }
    for (const s of o.shipments || []) {
      if (s.delivered_at && s.number) delivered.add(String(s.number));
    }
  }
  return { problems, delivered };
}
