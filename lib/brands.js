// Brand routing + per-brand credentials.
// The router decides which brand an email belongs to from the ORIGINAL recipient,
// which auto-forwarding often hides. We check the reliable headers first, then the
// visible To, then fall back to scanning the forwarded body.

export const BRANDS = {
  elderemo:  { name: 'Elder Emo', addresses: ['hello@elderemo.com', 'orders@elderemo.com', 'support@elderemo.com', 'hello@areyouevenemo.com', 'support@areyouevenemo.com'] },
  poppunks:  { name: 'PopPunks',  addresses: ['hello@poppunks.com', 'support@poppunks.com'] },
  wallspoke: { name: 'Wallspoke', addresses: ['hello@wallspoke.com', 'support@wallspoke.com'] },
};

const ADDRESS_TO_BRAND = {};
for (const [key, cfg] of Object.entries(BRANDS)) {
  for (const addr of cfg.addresses) ADDRESS_TO_BRAND[addr.toLowerCase()] = key;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Ordered by trust. Delivered-To and the X-*-To variants survive forwarding best.
const RECIPIENT_HEADERS = ['delivered-to', 'x-original-to', 'x-forwarded-to', 'to', 'cc'];

function matchKnownAddress(text) {
  if (!text) return null;
  const found = String(text).toLowerCase().match(EMAIL_RE) || [];
  for (const addr of found) {
    if (ADDRESS_TO_BRAND[addr]) return { brand: ADDRESS_TO_BRAND[addr], matchedOn: addr };
  }
  return null;
}

// headers: lowercase-keyed object of header name -> value string.
export function resolveBrand(headers = {}, body = '') {
  for (const h of RECIPIENT_HEADERS) {
    const hit = matchKnownAddress(headers[h]);
    if (hit) return { ...hit, source: 'header:' + h };
  }
  // Last resort: the forwarded original often quotes "To: hello@brand.com" in the body.
  const hit = matchKnownAddress(body);
  if (hit) return { ...hit, source: 'body' };

  return { brand: 'unknown', matchedOn: null, source: 'none' };
}

// Per-brand Shopify + vendor config pulled from env.
export function brandConfig(brand) {
  const up = brand.toUpperCase();
  return {
    shopify: {
      domain: process.env[up + '_SHOPIFY_DOMAIN'],
      token: process.env[up + '_SHOPIFY_TOKEN'],
    },
    printifyShopId: process.env[up + '_PRINTIFY_SHOP_ID'],
    printfulStoreId: process.env[up + '_PRINTFUL_STORE_ID'],
  };
}

// Which brands have full Shopify credentials configured (used for cross-brand order lookup).
export function configuredShopifyBrands() {
  return Object.keys(BRANDS).filter((b) => {
    const up = b.toUpperCase();
    return (
      process.env[up + '_SHOPIFY_DOMAIN'] &&
      process.env[up + '_SHOPIFY_CLIENT_ID'] &&
      process.env[up + '_SHOPIFY_CLIENT_SECRET']
    );
  });
}

// -------------------------------------------------------------------------------------
// Brand voice. Edit these freely to tune how replies sound for each brand. Keep them a
// few sentences describing tone, vocabulary, and attitude. They are injected into the
// draft prompt. The GLOBAL_STYLE below applies to every brand on top of the voice.
// -------------------------------------------------------------------------------------

export const GLOBAL_STYLE = [
  'Global style rules, apply to every brand, always:',
  '- Never use an em dash or an en dash anywhere. Use commas, periods, or separate sentences instead.',
  '- Sound warm, human, and concise. Never corporate, never robotic, never over-apologetic.',
  '- Only state facts given in the order status. Never invent tracking numbers, dates, or promises.',
  '- Do not use placeholder names or square brackets. Write a ready-to-send reply.',
].join('\n');

const VOICES = {
  elderemo:
    'Elder Emo talks like a fellow millennial who grew up on 2000s emo and pop punk. Warm, a little self-aware and funny about being an "elder emo" now, references that era lightly without trying too hard. Friendly and real, like texting a friend from the scene.',
  poppunks:
    'PopPunks is high-energy and upbeat, full of pop punk enthusiasm. Punchy sentences, genuine excitement, the occasional exclamation point, but never spammy or fake-hyped. Encouraging and fun.',
  wallspoke:
    'Wallspoke is calmer and craft-focused, centered on personalized map wall art. Warm, thoughtful, and a little sentimental about the meaning behind a place. Helpful and clear, lighter on slang, more on care and quality.',
  unknown:
    'A friendly, warm, brand-neutral customer support voice. Helpful and human.',
};

export function brandVoice(brand) {
  return VOICES[brand] || VOICES.unknown;
}

// -------------------------------------------------------------------------------------
// Reply structure. The shared skeleton every draft follows, across all brands. Edit the
// wording here to change how replies are shaped. The apology is conditional on the issue.
// -------------------------------------------------------------------------------------

export const REPLY_STRUCTURE = [
  'Reply structure, follow this shape for every reply:',
  '1. Greeting on its own line: "Hi <first name>," using the customer\'s first name when known. If the name is not known, use a warm neutral greeting.',
  '2. Opening line: thank them for their order. If something went wrong (a delay, a damaged or defective item, a lost or missing order, or the wrong item), add a short apology right after, in the spirit of "Thanks for your order and I\'m sorry that happened." For neutral requests (sizing help, address change, restock, general questions), just thank them with no apology.',
  '3. Body: answer the question or resolve the issue using the order status facts. Be proactive and offer to make it right. When it fits, offer a concrete fix: swap a size, send a replacement, or refund shipping for the inconvenience. If you need a detail to help (for damage, ask briefly what exactly is wrong and ask for a photo), ask for it.',
  '4. Close with a short thanks, like "Thanks!" or "Thanks again!".',
  '5. Sign off on its own line exactly as: -Mike',
].join('\n');
