// Slack notifications for at-risk orders.
//
// Delivery is a plain Incoming Webhook: one URL in SLACK_WEBHOOK_URL, no OAuth, no scopes,
// no token refresh. Slack's mobile app turns the post into a phone push, which is the
// whole point. If the variable is unset every function here quietly no-ops, so the scan
// runs identically on a machine with no Slack configured.
//
// Nothing in this file is allowed to throw. A dead webhook must never cost us a scan.

const MAX_ORDERS_PER_MESSAGE = 10;

export function slackEnabled() {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

// Where the At risk tab lives, for the "see all" links. Vercel injects
// VERCEL_PROJECT_PRODUCTION_URL automatically; APP_BASE_URL overrides it locally.
function appUrl() {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return 'https://' + vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return null;
}

export async function postSlack({ text, blocks }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
    });
    return res.ok;
  } catch {
    return false; // best effort, same as the vendor lookups
  }
}

const BRAND_NAMES = { elderemo: 'Elder Emo', poppunks: 'PopPunks', wallspoke: 'Wallspoke' };
const brandName = (b) => BRAND_NAMES[b] || b;

// Slack mrkdwn escaping. Order numbers and customer names are merchant-controlled, but
// they still must not be able to break the message or inject a link.
function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function orderLine(r) {
  const who = r.customerName || r.customerEmail || 'Unknown customer';
  const head = r.shopifyAdminUrl
    ? '<' + r.shopifyAdminUrl + '|' + esc(r.orderNumber || r.orderId) + '>'
    : '*' + esc(r.orderNumber || r.orderId) + '*';
  const bits = [
    '*' + esc(brandName(r.brand)) + '*  ' + head + '  ·  ' + esc(who) + '  ·  ' + r.ageDays + 'd old',
    '_' + esc((r.reasons || []).join(' · ')) + '_',
  ];
  if (r.items) bits.push(esc(String(r.items).slice(0, 140)));
  return bits.join('\n');
}

function orderBlocks(rows) {
  const shown = rows.slice(0, MAX_ORDERS_PER_MESSAGE);
  const blocks = shown.map((r) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: orderLine(r) },
  }));
  const hidden = rows.length - shown.length;
  if (hidden > 0) {
    const base = appUrl();
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '+ ' + hidden + ' more' + (base ? '  ·  <' + base + '|open the At risk tab>' : ''),
      }],
    });
  } else {
    const base = appUrl();
    if (base) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '<' + base + '|Open Backstage>' }] });
  }
  return blocks;
}

// Immediate alert: orders that just became high severity. These are the ones only Mike can
// unblock, a manual item unshipped or a print vendor reporting a problem.
export function riskAlertMessage(rows) {
  const n = rows.length;
  const text = n === 1
    ? 'New at-risk order: ' + (rows[0].orderNumber || rows[0].orderId)
    : n + ' new at-risk orders';
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⚠️ ' + text, emoji: true } },
      ...orderBlocks(rows),
    ],
  };
}

// Daily digest: everything still sitting at medium, plus a count of outstanding highs so
// the picture is complete without re-pinging each one.
export function riskDigestMessage(high, medium) {
  const text = 'Daily at-risk digest: ' + high.length + ' high, ' + medium.length + ' medium';
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📋 ' + text, emoji: true } },
  ];
  if (!medium.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Nothing at medium risk today._' } });
  } else {
    blocks.push(...orderBlocks(medium));
  }
  if (high.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: high.length + ' high severity order' + (high.length === 1 ? '' : 's') + ' still outstanding, alerted separately.' }],
    });
  }
  return { text, blocks };
}
