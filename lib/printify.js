// Printify drill-down. Only called for line items Shopify shows as unshipped print
// products, to add production detail Shopify does not carry.
// Printify stores the originating Shopify order id on each order, so we match on that.

export async function getProductionStatus(shopId, shopifyOrderId) {
  const token = process.env.PRINTIFY_TOKEN;
  if (!token || !shopId) return null;

  const res = await fetch('https://api.printify.com/v1/shops/' + shopId + '/orders.json?limit=50', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) return null;
  const data = await res.json();

  const match = (data.data || []).find(
    (o) => String(o.metadata && o.metadata.shop_order_id) === String(shopifyOrderId)
  );
  if (!match) return null;

  return {
    vendor: 'printify',
    status: match.status, // on-hold, in-production, fulfilled, canceled, etc.
    shipments: (match.shipments || []).map((s) => ({ carrier: s.carrier, tracking: s.number })),
    // Per-order deep links are not stable; link to the orders list (searchable by number).
    link: 'https://printify.com/app/orders',
  };
}

// List recent Printify orders for a shop and return a map of Shopify order id -> status
// for any order whose status looks like a problem (on hold, has issue, canceled, etc.).
// Substring matching keeps this robust to exact Printify status naming.
export async function listProblemOrders(shopId) {
  const token = process.env.PRINTIFY_TOKEN;
  if (!token || !shopId) return {};
  const res = await fetch('https://api.printify.com/v1/shops/' + shopId + '/orders.json?limit=50', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) return {};
  const data = await res.json();
  const problems = {};
  for (const o of data.data || []) {
    const status = String(o.status || '').toLowerCase();
    if (/hold|issue|cancel|declin|error|action|not-received|failed/.test(status)) {
      const sid = o.metadata && o.metadata.shop_order_id;
      if (sid) problems[String(sid)] = o.status;
    }
  }
  return problems;
}
