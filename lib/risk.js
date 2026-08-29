// Proactive risk scan. Reads recent orders directly (not email) and flags the ones
// heading for trouble, so the team can act before a customer complains.
//
// Rules (thresholds in RISK_DAYS). Delivered and cancelled orders are never at risk.
import { listRecentOrders, buildLedger } from './shopify.js';
import { brandConfig, configuredShopifyBrands } from './brands.js';
import { listProblemOrders } from './printify.js';
import { listProblemOrders as listPrintfulProblems } from './printful.js';
import {
  replaceRiskOrders, getDismissals, pruneDismissals,
  getNotifiedRisks, markRisksNotified, pruneRiskNotifications, getSetting, setSetting,
} from './db.js';
import { slackEnabled, postSlack, riskAlertMessage, riskDigestMessage } from './notify.js';

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
  const { printifyShopId, printfulStoreId } = brandConfig(brand);
  let printifyProblems = {};
  if (printifyShopId) {
    try { printifyProblems = await listProblemOrders(printifyShopId); } catch { /* best effort */ }
  }
  let printfulProblems = {};
  if (process.env.PRINTFUL_TOKEN) {
    try { printfulProblems = await listPrintfulProblems(printfulStoreId); } catch { /* best effort */ }
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

    // Rule: Printful flags a problem (external_id may be the Shopify order id or name)
    const pfProblem = printfulProblems[String(order.id)] || printfulProblems[String(order.name)];
    if (pfProblem) {
      reasons.push({ id: 'printful', text: 'Printful: ' + pfProblem });
      severity = 'high';
    }

    if (reasons.length) {
      const c = order.customer || {};
      const itemsSummary = items
        .map((it) => (it.quantity > 1 ? it.quantity + 'x ' : '') + it.name)
        .join(' / ');
      const ruleKey = [...new Set(reasons.map((r) => r.id))].sort().join('+'); // stable across day counts
      flagged.push({
        orderId: String(order.id),
        brand,
        orderNumber: order.name,
        customerName: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
        customerEmail: order.email || null,
        items: itemsSummary,
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

// The scan runs every four hours, so the digest rides whichever run lands in this UTC
// hour rather than claiming a third Vercel cron slot (Hobby caps them, and ingest and
// scan already use both). Must be one of the scan's hours: 0, 4, 8, 12, 16, 20.
const DIGEST_HOUR_UTC = Number(process.env.RISK_DIGEST_HOUR_UTC || 12);
const DIGEST_SETTING_KEY = 'risk_digest_last_sent';

// Slack is best effort throughout: a dead webhook must never cost us the scan itself,
// which is the same rule the vendor lookups follow in lib/fulfillment.js.
async function notifyNewHighRisk(visible) {
  const notified = await getNotifiedRisks(); // { orderId: ruleKey }
  const fresh = visible.filter(
    (f) => f.severity === 'high' && notified[f.orderId] !== f.ruleKey
  );
  if (!fresh.length) return 0;

  const sent = await postSlack(riskAlertMessage(fresh));
  // Only record what Slack actually accepted, so a failed post retries on the next scan
  // instead of being silently swallowed.
  if (!sent) return 0;
  await markRisksNotified(fresh);
  return fresh.length;
}

async function maybeSendDigest(visible, now) {
  if (now.getUTCHours() !== DIGEST_HOUR_UTC) return false;

  const today = now.toISOString().slice(0, 10);
  if ((await getSetting(DIGEST_SETTING_KEY)) === today) return false; // already sent today

  const high = visible.filter((f) => f.severity === 'high');
  const medium = visible.filter((f) => f.severity === 'medium');
  const sent = await postSlack(riskDigestMessage(high, medium));
  if (!sent) return false;
  await setSetting(DIGEST_SETTING_KEY, today);
  return true;
}

export async function runScan(now = new Date()) {
  const flagged = await scanAll();
  const dismissed = await getDismissals(); // { orderId: ruleKey }
  // Hide an order only if it was dismissed for the SAME set of reasons. A new problem resurfaces it.
  const visible = flagged.filter((f) => dismissed[f.orderId] !== f.ruleKey);
  await replaceRiskOrders(visible);
  // Drop dismissals for orders that are no longer flagged at all, so they can return later.
  await pruneDismissals(flagged.map((f) => f.orderId));

  let alerted = 0;
  let digestSent = false;
  if (slackEnabled()) {
    try {
      alerted = await notifyNewHighRisk(visible);
      digestSent = await maybeSendDigest(visible, now);
      // Forget orders that dropped off entirely, so the same problem can alert again later.
      await pruneRiskNotifications(flagged.map((f) => f.orderId));
    } catch {
      // Never let notification trouble fail a scan that already wrote its results.
    }
  }

  return {
    atRisk: visible.length,
    high: visible.filter((f) => f.severity === 'high').length,
    medium: visible.filter((f) => f.severity === 'medium').length,
    dismissedHidden: flagged.length - visible.length,
    slack: slackEnabled() ? { alerted, digestSent } : 'not configured',
  };
}
