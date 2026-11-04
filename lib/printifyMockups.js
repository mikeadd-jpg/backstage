// The original Printify mockups of a store's products, per colour, for the mockup
// generator to start from. The flat Printify mockups were removed from the Shopify
// listings, which left the generator working from a lifestyle shot (a scene made from a
// scene); Printify still has them all.
//
// Printify's product list carries every mockup and every variant's SKU but not the link
// to Shopify (that is only on a single-product read, one request per product, 1,200+ for
// Elder Emo). Shopify variants keep the same SKUs, so one sweep of the list (50 a page)
// is matched to Shopify products by SKU. The sweep is cached in insights_cache for
// CACHE_HOURS; stores without a Printify shop (Wallspoke, on Printful) have none and keep
// their Shopify images.
import { getInsightsCache, putInsightsCache } from './db.js';
import { brandConfig } from './brands.js';

const CACHE_HOURS = 12;
const PAGE = 50;
const AT_ONCE = 5;
// The number is bumped when the summary gains a field (2: each colour's back view), so an
// older copy without it is never served.
const cacheKey = (brand) => 'printify_mockups2_' + brand;

async function page(shopId, n) {
  const res = await fetch('https://api.printify.com/v1/shops/' + shopId + '/products.json?limit=' + PAGE + '&page=' + n, {
    headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN },
  });
  if (!res.ok) throw new Error('Printify ' + res.status + ' listing products');
  return res.json();
}

// One product's mockups by colour: the front view for each colour it is made in (the
// default camera when there are several) and that colour's back view. `hasBack` says the
// design has artwork on the back (a back print area with an image in it): Printify shows a
// back view of every garment, blank or not, so the view alone does not say there is a
// back design to shoot.
function summarize(p) {
  const colorOpt = (p.options || []).findIndex((o) => o.type === 'color');
  const values = colorOpt >= 0 ? p.options[colorOpt].values : [];
  const byVariant = new Map((p.variants || []).filter((v) => v.is_enabled !== false).map((v) => [v.id, v]));
  const view = (pos, vids) => {
    const imgs = (p.images || []).filter((im) => im.position === pos && (im.variant_ids || []).some((id) => vids.includes(id)));
    return (imgs.find((im) => im.is_default) || imgs[0] || {}).src || null;
  };
  const colors = [];
  for (const val of values) {
    const vids = [...byVariant.values()].filter((v) => (v.options || []).includes(val.id)).map((v) => v.id);
    if (!vids.length) continue;
    const front = view('front', vids);
    if (front) colors.push({ name: val.title, hex: (val.colors || [])[0] || null, front, back: view('back', vids) });
  }
  const hasBack = (p.print_areas || []).some((a) => (a.placeholders || []).some((ph) => ph.position === 'back' && (ph.images || []).length > 0));
  const back = ((p.images || []).find((im) => im.position === 'back' && im.is_default) || (p.images || []).find((im) => im.position === 'back') || {}).src || null;
  const def = (p.images || []).find((im) => im.is_default && im.position === 'front');
  const defaultColor = def ? (colors.find((c) => c.front === def.src) || {}).name : null;
  return { printifyId: p.id, colors, back, hasBack, defaultColor: defaultColor || (colors[0] && colors[0].name) || null };
}

/**
 * { products: [summary], bySku: { sku: index } } for a brand. A fresh sweep of Elder Emo
 * takes ~40s, so with `staleOk` an expired copy is returned at once with `stale: true`,
 * for the caller to refresh after responding; only a store never swept waits.
 */
export async function printifyMockupIndex(brand, { force = false, staleOk = false } = {}) {
  const shopId = brandConfig(brand).printifyShopId;
  if (!shopId || !process.env.PRINTIFY_TOKEN) return null;
  if (!force) {
    const hit = await getInsightsCache(cacheKey(brand));
    const fresh = hit && Date.now() - new Date(hit.fetchedAt) < CACHE_HOURS * 3600000;
    if (fresh) return hit.data;
    if (hit && staleOk) return { ...hit.data, stale: true };
  }
  const first = await page(shopId, 1);
  const pages = [first];
  const rest = Array.from({ length: Math.max(0, (first.last_page || 1) - 1) }, (_, i) => i + 2);
  for (let i = 0; i < rest.length; i += AT_ONCE) {
    pages.push(...(await Promise.all(rest.slice(i, i + AT_ONCE).map((n) => page(shopId, n)))));
  }
  const products = [];
  const bySku = {};
  for (const pg of pages) {
    for (const p of pg.data || []) {
      const s = summarize(p);
      if (!s.colors.length) continue;
      const idx = products.push(s) - 1;
      for (const v of p.variants || []) if (v.sku) bySku[v.sku] = idx;
    }
  }
  const data = { products, bySku, at: new Date().toISOString() };
  await putInsightsCache(cacheKey(brand), data);
  return data;
}

/** The Printify mockups for a Shopify product, found by any of its variant SKUs, or null. */
export function mockupsFor(index, skus) {
  if (!index) return null;
  for (const sku of skus || []) {
    const i = index.bySku[sku];
    if (i !== undefined) return index.products[i];
  }
  return null;
}

/**
 * The picture a shot of `colorName` starts from. When the design has a back, the back is
 * the default: the owner's rule is to lead with the back design unless the front is asked
 * for (`side: 'front'`). Returns { color, image, side, hasBack }.
 */
export function shotOf(m, colorName, side) {
  const c = (colorName && m.colors.find((x) => x.name.toLowerCase() === String(colorName).toLowerCase()))
    || m.colors.find((x) => x.name === m.defaultColor) || m.colors[0];
  if (!c) return null;
  const back = Boolean(m.hasBack && side !== 'front' && c.back);
  return { color: c.name, image: back ? c.back : c.front, side: back ? 'back' : 'front', hasBack: Boolean(m.hasBack) };
}
