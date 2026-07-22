// Gmail ingest. Pulls new messages from the single shared inbox and parses each into
// a normalized shape the rest of the pipeline can use.
import { google } from 'googleapis';

function client() {
  const oauth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth });
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
export async function listMessageIds(query = process.env.GMAIL_QUERY || 'newer_than:2d') {
  const gmail = client();
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  return (list.data.messages || []).map((m) => m.id);
}

// Expensive: one API call per id. Only call this for ids you actually need.
export async function fetchMessagesByIds(ids) {
  const gmail = client();
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
