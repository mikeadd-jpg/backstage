// Proactive risk scan. Reads recent orders directly (not email) and flags the ones
// heading for trouble, so the team can act before a customer complains.
//
// Rules (thresholds in RISK_DAYS). Delivered and cancelled orders are never at risk.
import { listRecentOrders, getOrdersByIds, buildLedger } from './shopify.js';
import { brandConfig, configuredShopifyBrands } from './brands.js';
import { listRecentOrderSignals } from './printify.js';
import { listProblemOrders as listPrintfulProblems } from './printful.js';
import {
  replaceRiskOrders, upsertRiskOrders, deleteRiskOrders, getRiskOrders, getDismissals, pruneDismissals,
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

// Everything the vendors can tell us about a brand's orders from the last sinceDays.
// Best effort per vendor, but `complete` records whether every configured vendor
// answered, because the tab re-check must not read "lookup failed" as "problem solved".
async function vendorSignals(brand, sinceDays) {
  const { printifyShopId, printfulStoreId } = brandConfig(brand);
  const signals = { printifyProblems: {}, delivered: new Set(), printfulProblems: {}, complete: true };
  if (printifyShopId) {
    try {
      const { problems, delivered } = await listRecentOrderSignals(printifyShopId, sinceDays);
      signals.printifyProblems = problems;
      signals.delivered = delivered;
    } catch { signals.complete = false; }
  }
  if (process.env.PRINTFUL_TOKEN) {
    try { signals.printfulProblems = await listPrintfulProblems(printfulStoreId, sinceDays); }
    catch { signals.complete = false; }
  }
  return signals;
}

// A shipment counts as delivered if Shopify says so, or if Printify has seen its
// tracking number delivered. Shopify's carrier feed sometimes stops updating partway
// (DHL eCommerce does this), while Printify keeps following the parcel.
function isDelivered(f, signals) {
  if (String(f.shipment_status || '') === 'delivered') return true;
  return (f.tracking_numbers || []).some((n) => signals.delivered.has(String(n)));
}

// The single judgement of whether one order is at risk, shared by the scheduled scan
// and the tab's live re-check so the two can never disagree. Returns a flagged row, or
// null when the order is fine. Never at risk: cancelled orders, or orders where every
// shipment is delivered.
function assessOrder(order, brand, signals) {
  if (order.cancelled_at) return null;
  const fulfillments = order.fulfillments || [];
  if (fulfillments.length > 0 && fulfillments.every((f) => isDelivered(f, signals))) return null;

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
    if (isDelivered(f, signals)) continue;            // delivered = fine
    const st = String(f.shipment_status || '');
    if (!IN_TRANSIT.has(st)) continue;                // unknown/empty = cannot confirm, do not flag
    if (daysSince(f.created_at || order.created_at) > RISK_DAYS.delivery) {
      reasons.push({ id: 'delivery', text: 'In transit ' + Math.floor(daysSince(f.created_at || order.created_at)) + ' days, not delivered' });
    }
  }

  // Rule: Printify flags a problem
  if (signals.printifyProblems[String(order.id)]) {
    reasons.push({ id: 'printify', text: 'Printify: ' + signals.printifyProblems[String(order.id)] });
    severity = 'high';
  }

  // Rule: Printful flags a problem (external_id may be the Shopify order id or name).
  // A draft was never submitted, so nothing is being made until someone confirms it.
  // Give it the same grace as a manual item, since confirming it is the same kind of job.
  const pfProblem = signals.printfulProblems[String(order.id)] || signals.printfulProblems[String(order.name)];
  const isDraft = String(pfProblem || '').toLowerCase() === 'draft';
  if (pfProblem && (!isDraft || ageDays > RISK_DAYS.manual)) {
    reasons.push({
      id: 'printful',
      text: isDraft ? 'Printful: draft, never submitted ' + Math.floor(ageDays) + ' days' : 'Printful: ' + pfProblem,
    });
    severity = 'high';
  }

  if (!reasons.length) return null;
  const c = order.customer || {};
  const itemsSummary = items
    .map((it) => (it.quantity > 1 ? it.quantity + 'x ' : '') + it.name)
    .join(' / ');
  const ruleKey = [...new Set(reasons.map((r) => r.id))].sort().join('+'); // stable across day counts
  return {
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
  };
}

export async function scanBrand(brand) {
  const [orders, signals] = await Promise.all([
    listRecentOrders(brand, 30),
    vendorSignals(brand, 30),
  ]);
  return orders.map((o) => assessOrder(o, brand, signals)).filter(Boolean);
}

export async function scanAll() {
  const all = [];
  for (const brand of configuredShopifyBrands()) {
    try { all.push(...(await scanBrand(brand))); } catch { /* skip a failing brand */ }
  }
  all.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'high' ? -1 : 1) : b.ageDays - a.ageDays));
  return all;
}

// The tab is a snapshot from the last scan, up to four hours old. Parcels get delivered
// and vendor holds get released in between, so before showing it, re-judge exactly the
// listed orders against live Shopify and vendor data with the same assessOrder the scan
// uses. Settled orders are deleted, changed ones rewritten. Nothing new is added; that
// stays the scan's job.
//
// Best effort, per brand: if Shopify or any of the brand's vendors fails to answer, that
// brand's rows are shown exactly as the scan left them rather than half-judged.
export async function refreshRiskOrders(rows) {
  const byBrand = {};
  for (const r of rows) (byBrand[r.brand] ||= []).push(r);

  const gone = [];
  const changed = [];
  let dismissed = null;
  await Promise.all(
    Object.entries(byBrand).map(async ([brand, brandRows]) => {
      try {
        // Vendor lists page newest first, so only reach back as far as the oldest row.
        const sinceDays = Math.max(...brandRows.map((r) => r.age_days || 0)) + 2;
        const [orders, signals] = await Promise.all([
          getOrdersByIds(brand, brandRows.map((r) => r.order_id)),
          vendorSignals(brand, sinceDays),
        ]);
        if (!signals.complete) return;
        dismissed ||= getDismissals();
        const dismissals = await dismissed;

        const byId = Object.fromEntries(orders.map((o) => [String(o.id), o]));
        for (const row of brandRows) {
          const order = byId[row.order_id];
          if (!order) continue; // not returned: leave it alone
          const next = assessOrder(order, brand, signals);
          if (!next || dismissals[next.orderId] === next.ruleKey) gone.push(row.order_id);
          else if (next.ruleKey !== row.rule_key || JSON.stringify(next.reasons) !== JSON.stringify(row.reasons)) {
            changed.push(next);
          }
        }
      } catch { /* keep this brand's rows as they are */ }
    })
  );
  if (!gone.length && !changed.length) return rows;

  try {
    await deleteRiskOrders(gone);
    await upsertRiskOrders(changed);
    return await getRiskOrders();
  } catch {
    // Could not write: still hide what is settled, this time.
    return rows.filter((r) => !gone.includes(r.order_id));
  }
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
