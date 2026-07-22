// The full ingest pipeline:
//   Gmail -> brand router -> classifier -> order lookup (Shopify first, cross-brand
//   fallback) -> draft -> store.
//
// Built to survive a serverless time limit: we list message ids first (one cheap call),
// drop the ones already in the database, then process only a capped batch of genuinely
// new mail. Anything left over is picked up by the next run, so nothing is lost.
import { listMessageIds, fetchMessagesByIds } from './gmail.js';
import { resolveBrand, BRANDS } from './brands.js';
import { classifyEmail, draftReply } from './classify.js';
import { resolveOrderStatus, resolveOrderAcrossBrands } from './fulfillment.js';
import { filterUnprocessed, insertInquiry } from './db.js';

// How many new emails to fully process in one run, and when to stop and leave the rest
// for the next run. Keep the budget under the function's maxDuration.
const MAX_PER_RUN = 8;
const TIME_BUDGET_MS = 45000;

// Fallback order-number extraction if the classifier misses it.
function extractOrderNumber(text = '') {
  const patterns = [
    /#\s?([A-Za-z]{0,5}-?\d{3,})/,
    /order\s*(?:#|number|no\.?|id)?\s*[:#]?\s*([A-Za-z]{0,5}-?\d{3,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

export async function runIngest() {
  const startedAt = Date.now();
  const result = {
    seen: 0, newMail: 0, processed: 0, support: 0, remaining: 0, errors: [],
  };

  // 1. Cheap listing, then dedupe before any expensive fetching.
  const ids = await listMessageIds();
  result.seen = ids.length;
  const fresh = await filterUnprocessed(ids);
  result.newMail = fresh.length;
  if (fresh.length === 0) return result;

  const batch = fresh.slice(0, MAX_PER_RUN);
  result.remaining = fresh.length - batch.length;

  // 2. Fetch full bodies only for the new ones.
  const messages = await fetchMessagesByIds(batch);

  for (const msg of messages) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      result.remaining += 1; // ran out of time, next run picks it up
      continue;
    }
    try {
      const routed = resolveBrand(msg.headers, msg.body);
      let brand = routed.brand;
      let matchedOn = routed.matchedOn;

      const cls = await classifyEmail({
        subject: msg.subject,
        body: msg.body,
        brandName: BRANDS[brand] ? BRANDS[brand].name : 'Unknown',
      });

      let orderStatus = null;
      let draft = null;
      let confidence = null;

      if (cls.is_support) {
        result.support++;
        const orderNumber = cls.order_number || extractOrderNumber(msg.body) || extractOrderNumber(msg.subject);
        const email = cls.customer_email || msg.from;

        if (brand !== 'unknown') {
          orderStatus = await resolveOrderStatus(brand, { orderNumber, email });
          if ((!orderStatus || !orderStatus.found) && orderNumber) {
            const cross = await resolveOrderAcrossBrands({ orderNumber }, [brand]);
            if (cross) { brand = cross.brand; matchedOn = null; orderStatus = cross.status; }
          }
        } else if (orderNumber || email) {
          const cross = await resolveOrderAcrossBrands({ orderNumber, email });
          if (cross) { brand = cross.brand; matchedOn = null; orderStatus = cross.status; }
        }

        const d = await draftReply({
          brand,
          issueType: cls.issue_type,
          issue: cls.summary + '\n\nOriginal message:\n' + msg.body.slice(0, 1500),
          orderStatus: orderStatus || { found: false, note: 'No order matched' },
        });
        draft = d.reply;
        confidence = d.confidence;
      }

      await insertInquiry({
        gmailId: msg.gmailId,
        brand,
        fromEmail: msg.from,
        toEmail: matchedOn,
        subject: msg.subject,
        receivedAt: msg.receivedAt,
        isSupport: !!cls.is_support,
        issueType: cls.issue_type,
        summary: cls.summary,
        body: msg.body,
        orderNumber: (orderStatus && orderStatus.orderNumber) || cls.order_number,
        orderStatus,
        needsAction: orderStatus ? orderStatus.needsAction : false,
        draftReply: draft,
        confidence,
      });

      result.processed++;
    } catch (err) {
      result.errors.push({ subject: msg.subject, message: String(err.message || err) });
    }
  }

  result.tookMs = Date.now() - startedAt;
  return result;
}
