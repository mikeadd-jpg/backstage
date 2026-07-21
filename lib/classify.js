// Two Anthropic calls: a cheap classifier that decides if an email is a support
// inquiry and extracts structure, and a drafting call that writes the reply in the
// brand's voice once we know the order status.
import Anthropic from '@anthropic-ai/sdk';
import { BRANDS, brandVoice, GLOBAL_STYLE, REPLY_STRUCTURE } from './brands.js';
import { getVoiceRow, getSetting } from './db.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';

function parseJson(text) {
  const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// Hard guarantee: no em dash or en dash ever reaches the dashboard, whatever the model does.
function stripDashes(s = '') {
  return s
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2') // numeric ranges: 2–4 -> 2 to 4
    .replace(/(\w)\s*[—–]\s*(\w)/g, '$1, $2')   // word—word -> word, word
    .replace(/[—–]/g, '-')                      // any stray dash -> hyphen
    .replace(/,\s*,/g, ',')                     // clean any doubled commas
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function classifyEmail({ subject, body, brandName }) {
  const res = await anthropic.messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 400,
    system:
      'You triage customer service email for the ' + brandName + ' merch store. ' +
      'Return ONLY a JSON object, no prose, no markdown fences, with keys: ' +
      'is_support (boolean), issue_type (short label like "Where is my order", "Damaged item", ' +
      '"Refund request", "Address change", "Size exchange", "General question"), ' +
      'summary (one plain sentence describing the issue), ' +
      'order_number (string or null), customer_email (string or null).',
    messages: [{ role: 'user', content: 'Subject: ' + subject + '\n\n' + body }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseJson(text);
}

export async function draftReply({ brand, brandName, issue, issueType, orderStatus }) {
  const name = brandName || (BRANDS[brand] && BRANDS[brand].name) || 'our store';
  // Shared, editable voice + reply structure from the database, falling back to code defaults.
  let voice = brandVoice(brand);
  let structure = REPLY_STRUCTURE;
  try {
    const [dbVoice, dbStructure] = await Promise.all([getVoiceRow(brand), getSetting('cs_reply_structure')]);
    if (dbVoice) voice = dbVoice;
    if (dbStructure) structure = dbStructure;
  } catch { /* DB not ready: use defaults */ }

  const res = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 600,
    system:
      'You write customer support replies for ' + name + ', an emo and pop-punk merch brand.\n\n' +
      'BRAND VOICE:\n' + voice + '\n\n' + structure + '\n\n' + GLOBAL_STYLE + '\n\n' +
      'Use the order status facts provided. Return ONLY a JSON object with keys: ' +
      'reply (string, the full email body ready to send), confidence (number 0 to 1 for how ' +
      'well the facts cover the question). No markdown fences.',
    messages: [
      {
        role: 'user',
        content:
          'Issue type: ' + (issueType || 'General question') + '\n\n' +
          'Customer issue:\n' + issue + '\n\n' +
          'Resolved order status (JSON):\n' + JSON.stringify(orderStatus, null, 2),
      },
    ],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJson(text);
  return { reply: stripDashes(parsed.reply), confidence: parsed.confidence };
}
