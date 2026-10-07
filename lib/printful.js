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

// Draft orders waiting for a human to check the print file, for the Approvals tab.
// Wallspoke's map files are generated per order, so a bad render would otherwise be
// printed and shipped. Each item's "default" file is the print file; "preview" files are
// Printful's own mockups. Display uses preview_url (Printful's CDN, stable) because the
// file's own url is a 15 minute signed link from the generator and is usually expired.
export async function listDraftOrders(storeId) {
  if (!process.env.PRINTFUL_TOKEN) return [];
  const drafts = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(BASE + '/orders?status=draft&limit=' + PAGE_SIZE + '&offset=' + page * PAGE_SIZE, {
      headers: headers(storeId),
    });
    if (!res.ok) throw new Error('Printful ' + res.status + ' listing draft orders');
    const data = await res.json();
    const orders = data.result || [];
    for (const o of orders) {
      drafts.push({
        id: o.id,
        externalId: o.external_id ? String(o.external_id) : null,
        created: o.created ? new Date(o.created * 1000).toISOString() : null,
        recipient: o.recipient ? o.recipient.name : '',
        country: o.recipient ? o.recipient.country_code : '',
        cost: o.costs ? o.costs.total : null,
        currency: o.costs ? o.costs.currency : 'USD',
        error: o.error || null,
        dashboardUrl: o.dashboard_url || 'https://www.printful.com/dashboard/orders',
        items: (o.items || []).map((it) => ({
          name: it.name,
          quantity: it.quantity,
          outOfStock: !!it.out_of_stock,
          discontinued: !!it.discontinued,
          files: (it.files || []).filter((f) => f.type !== 'preview').map((f) => ({
            type: f.type,
            status: f.status,
            filename: decodeURIComponent(f.filename || ''),
            width: f.width,
            height: f.height,
            preview: f.preview_url || f.thumbnail_url || null,
          })),
          mockup: ((it.files || []).find((f) => f.type === 'preview') || {}).preview_url || null,
        })),
      });
    }
    const total = data.paging ? data.paging.total : 0;
    if (orders.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) break;
  }
  return drafts;
}

// Submit a draft for fulfillment. This is the step that charges the Printful account
// and starts production, so it is only ever called from an explicit button press.
export async function confirmOrder(orderId, storeId) {
  if (!process.env.PRINTFUL_TOKEN) throw new Error('PRINTFUL_TOKEN is not set');
  const res = await fetch(BASE + '/orders/' + encodeURIComponent(orderId) + '/confirm', {
    method: 'POST',
    headers: headers(storeId),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || data.result || res.status;
    throw new Error('Printful would not confirm order ' + orderId + ': ' + msg);
  }
  return { id: data.result.id, status: data.result.status };
}

// Decline a draft: Printful's cancel, which for a draft means it is withdrawn and never
// produced or charged. Used for drafts whose Shopify order was cancelled, or whose print
// is wrong and will be regenerated. Only ever called from an explicit button press.
export async function cancelOrder(orderId, storeId) {
  if (!process.env.PRINTFUL_TOKEN) throw new Error('PRINTFUL_TOKEN is not set');
  const res = await fetch(BASE + '/orders/' + encodeURIComponent(orderId), {
    method: 'DELETE',
    headers: headers(storeId),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || data.result || res.status;
    throw new Error('Printful would not cancel order ' + orderId + ': ' + msg);
  }
  return { id: data.result ? data.result.id : orderId, status: data.result ? data.result.status : 'canceled' };
}
