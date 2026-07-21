// The full ingest pipeline:
//   Gmail -> brand router -> classifier -> order lookup (Shopify first, cross-brand
//   fallback) -> draft -> store.
import { fetchNewMessages } from './gmail.js';
import { resolveBrand, BRANDS } from './brands.js';
import { classifyEmail, draftReply } from './classify.js';
import { resolveOrderStatus, resolveOrderAcrossBrands } from './fulfillment.js';
import { alreadyProcessed, insertInquiry } from './db.js';

// Fallback order-number extraction if the classifier misses it. Catches "#EE-10428",
// "order 10428", "order #10428", "order number 10428".
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
  const messages = await fetchNewMessages();
  const result = { seen: messages.length, processed: 0, support: 0, skipped: 0, errors: [] };

  for (const msg of messages) {
    try {
      if (await alreadyProcessed(msg.gmailId)) { result.skipped++; continue; }

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
          // Routed brand did not have it? Maybe it was misrouted. Try other stores by order number.
          if ((!orderStatus || !orderStatus.found) && orderNumber) {
            const cross = await resolveOrderAcrossBrands({ orderNumber }, [brand]);
            if (cross) { brand = cross.brand; matchedOn = null; orderStatus = cross.status; }
          }
        } else if (orderNumber || email) {
          // Unknown brand: let the order number (preferred) or email tell us the store.
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
      result.errors.push({ gmailId: msg.gmailId, message: String(err.message || err) });
    }
  }

  return result;
}
