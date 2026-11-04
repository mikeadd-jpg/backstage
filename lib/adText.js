// Catalogue (dynamic product) ads carry Meta's placeholders, "{{product.name}}" and the
// like, which Meta fills in per product when it shows the ad. Read raw they look like a
// broken headline, and Claude once took one for the ad's wording. These turn them into
// what they stand for. Pure, no imports: the tabs and the server both use it.

const PLACEHOLDER = /\{\{\s*([a-z_.]+)\s*\}\}/gi;
const NAMES = { 'product.name': "the product's name", 'product.brand': "the brand's name", 'product.price': "the product's price",
  'product.description': "the product's description", 'product.current_price': "the product's price" };

const HAS = /\{\{\s*[a-z_.]+\s*\}\}/i;
export const isCatalogText = (s) => HAS.test(String(s || ''));

/** For Claude: each placeholder written out as what Meta puts there, in brackets. */
export function explainPlaceholders(s) {
  return String(s || '').replace(PLACEHOLDER, (_, k) => '[' + (NAMES[k.toLowerCase()] || k.replace(/[._]/g, ' ')) + ', filled in per product]');
}

/** For people: the text without placeholders, or `fallback` when nothing else is left. */
export function withoutPlaceholders(s, fallback = '') {
  const out = String(s || '').replace(PLACEHOLDER, '').replace(/\s{2,}/g, ' ').trim();
  return out || fallback;
}
