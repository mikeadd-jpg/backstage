// Send a test Slack alert: `npm run test-alert`
//
// Posts one message through the same postSlack() the scan uses, so a success here proves
// the whole chain: env var, webhook URL, channel, and your phone's notification settings.
// Touches no order data and marks nothing as notified.
import { readFileSync } from 'fs';
import { postSlack, slackEnabled } from '../lib/notify.js';

try {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch { /* no .env.local: rely on the real environment */ }

if (!slackEnabled()) {
  console.error('SLACK_WEBHOOK_URL is not set. Add it to .env.local and try again.');
  process.exit(1);
}

const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const ok = await postSlack({
  text: 'Backstage test alert',
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: '✅ Backstage test alert', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: 'If you can see this on your phone, at-risk order alerts will reach you.' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent manually with `npm run test-alert` · ' + when }] },
  ],
});

if (ok) {
  console.log('Sent. Check Slack, and your phone.');
  console.log('If it appears on desktop but not your phone, the channel is muted or mobile notifications are off.');
} else {
  console.error('Slack rejected the post. The webhook URL is probably wrong, revoked, or its channel was deleted.');
  process.exit(1);
}
