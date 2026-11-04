// Gmail: ingest from the shared inbox, read a whole conversation (Sent included), and
// send a reply from the brand address the customer wrote to.
//
// Which mailbox: the one connected in Settings (lib/gmailAuth.js), else the env token.
// Sending needs the connected one, since the env token was granted read access only.
import { google } from 'googleapis';
import { gmailCredentials } from './gmailAuth.js';

async function client() {
  const creds = await gmailCredentials();
  const oauth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: creds.refreshToken });
  return { gmail: google.gmail({ version: 'v1', auth: oauth }), creds };
}

function decodeB64(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Walk the MIME tree and return the best text body (prefer text/plain).
function extractBody(payload) {
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (mime === 'text/plain' && part.body?.data) plain += decodeB64(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decodeB64(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return plain.trim() || stripHtml(html);
}

function headerMap(payload) {
  const out = {};
  for (const h of payload.headers || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function extractEmail(headerValue) {
  if (!headerValue) return null;
  const m = headerValue.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

// Cheap: one API call, returns just the message ids so we can dedupe before
// paying for full message fetches.
//
// Two guards on every query, whatever GMAIL_QUERY says:
// - Never our own mail. Once Backstage sends from the mailbox, an unfiltered list
//   returns those replies too, and each would come back as a new "inquiry".
// - Nothing older than the connection (`since`). Message ids differ per mailbox, so
//   the inquiries table cannot dedupe the days the previous mailbox already delivered.
export async function listMessageIds(query = process.env.GMAIL_QUERY || 'newer_than:2d') {
  const { gmail, creds } = await client();
  let q = query + ' -in:sent -in:drafts -from:me';
  if (creds.since) q += ' after:' + creds.since;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100 });
  return (list.data.messages || []).map((m) => m.id);
}

// Expensive: one API call per id. Only call this for ids you actually need.
export async function fetchMessagesByIds(ids) {
  const { gmail } = await client();
  const out = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const payload = msg.data.payload || {};
    const headers = headerMap(payload);
    out.push({
      gmailId: id,
      threadId: msg.data.threadId,
      headers,
      from: extractEmail(headers['from']),
      subject: headers['subject'] || '(no subject)',
      receivedAt: new Date(Number(msg.data.internalDate)).toISOString(),
      body: extractBody(payload),
    });
  }
  return out;
}

// ---- the whole conversation ---------------------------------------------------------

// Strip the quoted history Gmail and most clients append below a reply ("On ... wrote:"
// and "> " lines), so each message in a thread shows only what it added.
function newPart(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l, i) =>
    /^On .+wrote:\s*$/.test(l.trim()) ||
    (/^On .+/.test(l.trim()) && /wrote:\s*$/.test((lines[i + 1] || '').trim())) ||
    /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim()) ||
    /^From: .+/.test(l.trim()) && /^(Sent|Date): /.test((lines[i + 1] || '').trim()));
  const kept = (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/^>/.test(l));
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every message in the inquiry's Gmail thread, oldest first, our own replies included
 * (`sent: true`). Read live, so a reply sent from Gmail itself shows up here as well.
 */
export async function getThread(gmailId) {
  const { gmail } = await client();
  const msg = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'minimal' });
  const thread = await gmail.users.threads.get({ userId: 'me', id: msg.data.threadId, format: 'full' });
  return (thread.data.messages || []).map((m) => {
    const h = headerMap(m.payload || {});
    const body = extractBody(m.payload || {});
    return {
      id: m.id,
      from: h['from'] || '',
      to: h['to'] || '',
      date: new Date(Number(m.internalDate)).toISOString(),
      sent: (m.labelIds || []).includes('SENT'),
      body: (newPart(body) || body).slice(0, 6000),
    };
  });
}

// ---- sending ------------------------------------------------------------------------

const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const allEmails = (v) => (String(v || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);

/** The account's verified "Send mail as" addresses, with their signatures. */
export async function listSendAs() {
  const { gmail } = await client();
  const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
  return (res.data.sendAs || [])
    .filter((s) => s.isPrimary || s.verificationStatus === 'accepted')
    .map((s) => ({
      email: s.sendAsEmail.toLowerCase(),
      name: s.displayName || '',
      signature: s.signature || '',
      isDefault: Boolean(s.isDefault),
    }));
}

/**
 * Which address a reply to this message goes out from: the first address the customer
 * wrote to that is on the Send mail as list (the same rule as Gmail's "reply from the
 * same address"), else the account's default.
 */
function pickSender(headers, sendAs) {
  const listed = new Map(sendAs.map((s) => [s.email, s]));
  for (const h of ['to', 'cc', 'x-original-to', 'delivered-to']) {
    for (const addr of allEmails(headers[h])) if (listed.has(addr)) return listed.get(addr);
  }
  return sendAs.find((s) => s.isDefault) || sendAs[0];
}

/** Who a reply would go to and from, without sending. The Inbox shows this before Send. */
export async function replyPlan(gmailId) {
  const { gmail, creds } = await client();
  if (!creds.canSend) throw new Error('Sending needs the mailbox connected in Settings. Connect Gmail there first.');
  const orig = await gmail.users.messages.get({
    userId: 'me', id: gmailId, format: 'metadata',
    metadataHeaders: ['From', 'Reply-To', 'To', 'Cc', 'Delivered-To', 'X-Original-To', 'Subject', 'Message-ID', 'References'],
  });
  const h = headerMap(orig.data.payload || {});
  const sender = pickSender(h, await listSendAs());
  const subject = h['subject'] || '';
  return {
    threadId: orig.data.threadId,
    to: h['reply-to'] || h['from'],
    from: sender,
    subject: /^re:/i.test(subject.trim()) ? subject : 'Re: ' + subject,
    messageId: h['message-id'] || null,
    references: [h['references'], h['message-id']].filter(Boolean).join(' '),
  };
}

/**
 * Send `text` as a reply in the inquiry's thread, from the matching brand address, with
 * that address's Gmail signature appended (the API does not add signatures itself).
 */
export async function sendReply(gmailId, text) {
  const body = String(text || '').trim();
  if (!body) throw new Error('The reply is empty.');
  const plan = await replyPlan(gmailId);
  const { gmail } = await client();

  const sigHtml = plan.from.signature || '';
  const sigText = sigHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  const html = '<div dir="ltr">' + escapeHtml(body).replace(/\r?\n/g, '<br>') + '</div>' +
    (sigHtml ? '<br><div class="gmail_signature">' + sigHtml + '</div>' : '');
  const plain = body + (sigText ? '\n\n-- \n' + sigText : '');

  const boundary = 'bs_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const fromHeader = plan.from.name ? encodeHeader(plan.from.name) + ' <' + plan.from.email + '>' : plan.from.email;
  const lines = [
    'From: ' + fromHeader,
    'To: ' + plan.to,
    'Subject: ' + encodeHeader(plan.subject),
    plan.messageId ? 'In-Reply-To: ' + plan.messageId : null,
    plan.references ? 'References: ' + plan.references : null,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(plain, 'utf8').toString('base64'),
    '--' + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    '--' + boundary + '--',
  ].filter((l) => l !== null);

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url'), threadId: plan.threadId },
  });
  return { id: res.data.id, threadId: res.data.threadId, from: plan.from.email, to: plan.to };
}

/**
 * The inquiry's message id in the connected mailbox. Inquiries ingested before the
 * mailbox was switched carry the old mailbox's id, so when that id is not found here,
 * look the message up by sender, subject and day instead (the old mail was migrated
 * across). Returns null when it cannot be found.
 */
export async function findMessageId({ gmailId, from, subject, receivedAt }) {
  const { gmail } = await client();
  try {
    await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'minimal' });
    return gmailId;
  } catch (err) {
    if (Number(err.code || err.status) !== 404 && !/not found/i.test(String(err.message))) throw err;
  }
  if (!from) return null;
  const day = receivedAt ? Math.floor(new Date(receivedAt).getTime() / 1000) : null;
  let q = 'from:' + from + ' -in:sent';
  if (day) q += ' after:' + (day - 86400) + ' before:' + (day + 86400);
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
  const want = String(subject || '').trim().toLowerCase();
  for (const m of list.data.messages || []) {
    const got = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject'] });
    const s = String(headerMap(got.data.payload || {})['subject'] || '').trim().toLowerCase();
    if (!want || s === want) return m.id;
  }
  return null;
}
