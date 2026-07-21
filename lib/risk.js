// Proactive risk scan. Reads recent orders directly (not email) and flags the ones
// heading for trouble, so the team can act before a customer complains.
//
// Rules (thresholds in RISK_DAYS). Delivered and cancelled orders are never at risk.
import { listRecentOrders, buildLedger } from './shopify.js';
import { brandConfig, configuredShopifyBrands } from './brands.js';
import { listProblemOrders } from './printify.js';
import { replaceRiskOrders, getDismissals, pruneDismissals } from './db.js';

export const RISK_DAYS = {
  production: 3, // in production longer than this = risk
  delivery: 5,   // in transit (not delivered) longer than this = risk
  manual: 2,     // your manual item unshipped longer than this = risk
};

// Shopify shipment_status values that mean "shipped, on its way, not yet delivered".
// If the status is 'delivered' we skip it. If it is null/unknown we do NOT flag, because
// Shopify frequently leaves it empty even for delivered orders (that was the false-positive bug).
const IN_TRANSIT = new Set([
  'in_transit', 'out_for_delivery', 'attempted_delivery',
  'ready_for_pickup', 'confirmed', 'label_printed', 'label_purchased',
]);

function daysSince(iso) {
  if (!iso) return 0;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}
function adminUrl(brand, orderId) {
  const { shopify } = brandConfig(brand);
  if (!shopify.domain || !orderId) return null;
  const handle = shopify.domain.replace('.myshopify.com', '');
  return 'https://admin.shopify.com/store/' + handle + '/orders/' + orderId;
}

export async function scanBrand(brand) {
  const orders = await listRecentOrders(brand, 30);
  const { printifyShopId } = brandConfig(brand);
  let printifyProblems = {};
  if (printifyShopId) {
    try { printifyProblems = await listProblemOrders(printifyShopId); } catch { /* best effort */ }
  }

  const flagged = [];
  for (const order of orders) {
    // Never at risk: cancelled orders, or orders where every shipment is delivered.
    if (order.cancelled_at) continue;
    const fulfillments = order.fulfillments || [];
    const allDelivered =
      fulfillments.length > 0 &&
      fulfillments.every((f) => String(f.shipment_status || '') === 'delivered');
    if (allDelivered) continue;

    const items = buildLedger(order);
    const ageDays = daysSince(order.created_at);
    const reasons = []; // { id, text }
    let severity = 'medium';

    // Rule: stuck in production (a vendor item not yet shipped)
    if (items.some((i) => i.status === 'production') && ageDays > RISK_DAYS.production) {
      reasons.push({ id: 'production', text: 'In production ' + Math.floor(ageDays) + ' days' });
    }

    // Rule: your manual item still unshipped
    if (items.some((i) => i.fulfiller === 'you' && i.status === 'action') && ageDays > RISK_DAYS.manual) {
      reasons.push({ id: 'manual', text: 'Awaiting your fulfillment ' + Math.floor(ageDays) + ' days' });
      severity = 'high';
    }

    // Rule: shipped and positively in transit (not delivered) past the threshold
    for (const f of fulfillments) {
      const st = String(f.shipment_status || '');
      if (st === 'delivered') continue;                 // delivered = fine
      if (!IN_TRANSIT.has(st)) continue;                // unknown/empty = cannot confirm, do not flag
      if (daysSince(f.created_at || order.created_at) > RISK_DAYS.delivery) {
        reasons.push({ id: 'delivery', text: 'In transit ' + Math.floor(daysSince(f.created_at || order.created_at)) + ' days, not delivered' });
      }
    }

    // Rule: Printify flags a problem
    if (printifyProblems[String(order.id)]) {
      reasons.push({ id: 'printify', text: 'Printify: ' + printifyProblems[String(order.id)] });
      severity = 'high';
    }

    if (reasons.length) {
      const c = order.customer || {};
      const ruleKey = [...new Set(reasons.map((r) => r.id))].sort().join('+'); // stable across day counts
      flagged.push({
        orderId: String(order.id),
        brand,
        orderNumber: order.name,
        customerName: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
        customerEmail: order.email || null,
        reasons: reasons.map((r) => r.text),
        ruleKey,
        severity,
        ageDays: Math.floor(ageDays),
        shopifyAdminUrl: adminUrl(brand, order.id),
      });
    }
  }
  return flagged;
}

export async function scanAll() {
  const all = [];
  for (const brand of configuredShopifyBrands()) {
    try { all.push(...(await scanBrand(brand))); } catch { /* skip a failing brand */ }
  }
  all.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'high' ? -1 : 1) : b.ageDays - a.ageDays));
  return all;
}

export async function runScan() {
  const flagged = await scanAll();
  const dismissed = await getDismissals(); // { orderId: ruleKey }
  // Hide an order only if it was dismissed for the SAME set of reasons. A new problem resurfaces it.
  const visible = flagged.filter((f) => dismissed[f.orderId] !== f.ruleKey);
  await replaceRiskOrders(visible);
  // Drop dismissals for orders that are no longer flagged at all, so they can return later.
  await pruneDismissals(flagged.map((f) => f.orderId));
  return {
    atRisk: visible.length,
    high: visible.filter((f) => f.severity === 'high').length,
    medium: visible.filter((f) => f.severity === 'medium').length,
    dismissedHidden: flagged.length - visible.length,
  };
}
