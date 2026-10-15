// Printers per market, and building the products. Used by both the adult and kids builders.
//
// Two ways a product gets listed:
//   - Global Fulfillment (the Gildan 5000 and Comfort Colors 1717 today): ONE Printify
//     Choice listing that Printify makes and ships locally in the US, CA, UK, AU and EU.
//     It only works if every colour in the listing is eligible; a single ineligible colour
//     drops the whole product to regular Choice, where international buyers pay
//     international shipping. So the picker only ever offers eligible colours.
//   - Per market: one listing per market (US, CA, UK, AU), each with its own printer,
//     chosen by rankCandidates() below and overridable in the builder. Each listing is tagged
//     with its market (us, ca, uk, au) so it can be added to that Shopify market in bulk.
//
// Where the data comes from:
//   - Printify's API: in-stock variants per printer (colours, sizes, print areas) and the
//     v2 shipping table (cost and delivery days per destination).
//   - Printify's own catalog pages (printify.com/product-catalog-service), because the API
//     has no base price, rating, production time or Global Fulfillment flag. That endpoint
//     is undocumented: if it stops answering, ranking falls back to shipping alone and the
//     Global Fulfillment listing is unavailable rather than guessed.
// Printer prices barely move, so the whole builder catalog is saved in insights_cache and
// refreshed once a week by the /api/printers-refresh cron; the builder reads that copy in
// one query instead of asking Printify. Stock is still checked live at build time.
import { getStoreByShopId, getProductConfig, getInsightsCache, putInsightsCache } from './db.js';
import { VARIANTS, GARMENT_ORDER } from './builder.js';
import { KIDS_CATALOG } from './kids.js';
import { groupByColor } from './colors.js';

const API = 'https://api.printify.com';
const SITE = 'https://printify.com/product-catalog-service/api/v2/blueprints/';
// A day past the weekly refresh, so a missed cron run shows up as a slow first load rather
// than as prices silently older than two weeks.
const CACHE_TTL_MS = 8 * 24 * 3600 * 1000;
const CHOICE_ID = 99;
const GENERIC_PRICE_CENTS = 2499;
const UPSELL_TAG = 'upsellprod';
const UPSELL_EXEMPT = ['gildan_tee'];

// `ship` is the code in Printify's shipping table, `region` the one its catalog pages use
// for regional_shipping, `tag` goes on the product.
export const MARKETS = [
  { code: 'US', label: 'United States', ship: 'US', region: 'US', tag: 'us' },
  { code: 'CA', label: 'Canada', ship: 'CA', region: 'CAN', tag: 'ca' },
  { code: 'UK', label: 'United Kingdom', ship: 'GB', region: 'UK', tag: 'uk' },
  { code: 'AU', label: 'Australia', ship: 'AU', region: 'AUS', tag: 'au' },
];
export const GLOBAL = 'GLOBAL';

// ---- Picking the printer ----
//
// For each printer that offers the garment and ships to the market:
//   landed   = its lowest base price + first-item standard shipping to that market
//   delivery = its average production days + the slow end of its shipping estimate
//   rating   = Printify's own provider score out of 10
// **Nothing is shipped into a market that has a printer inside it.** So the candidates
// are cut to the local ones first, and everything below happens within that set; only a
// market with no printer of its own falls back to the rest. That outranks price: going
// local costs up to $5.30 on one garment (Comfort Colors in Canada) and is still right,
// because a 10-30 day cross-border parcel is a worse product than a dearer local one.
// `local` is read off the shipping lane, not the factory list: see candidateFor.
//
// Within that set, filters, each relaxed only when nothing passes it:
//   - stocks a black and a white, plus a dark grey and an off-white wherever the
//     garment's own default colours include one (CORE_FAMILIES)
//   - rated 8.0 or higher
// Relaxing matters more now that the set can be one printer: the only printer in the UK
// may lack a dark grey, and losing that colour beats shipping from Nevada.
//
// Then, in this order:
//   1. Printify Choice, when it is in the set (i.e. local). Only the US qualifies today:
//      Choice quotes the UK no rate of its own at all (it falls to rest-of-world, $10.39
//      and 10-30 days) and quotes CA and AU 10-30 day cross-border lanes. Its UK/AU
//      factories are reachable only through Global Fulfillment, a separate listing.
//   2. Otherwise price leads: the cheapest landed printer, unless one costing at most
//      UPGRADE_BAND more is faster or better rated, in which case the best mix of rating
//      and delivery inside that band wins (ties go to the cheaper).
// Every pick carries `why`, and the builder shows it next to the printer.
const UPGRADE_BAND = 75;      // cents: what the owner will pay for a faster or better printer
const DOMESTIC_MAX_DAYS = 7;  // a lane this fast is shipped from inside the market
const MIN_RATING = 8.0;
const CORE_COLOURS = ['Black', 'White'];
const CORE_FAMILIES = {
  black: ['black'],
  white: ['white'],
  // Each brand names these differently: AS Colour calls its dark grey Coal and its
  // off-whites Bone and Ecru, so a missing name reads as a missing colour family.
  'dark grey': ['charcoal', 'dark heather', 'pepper', 'graphite heather', 'graphite', 'asphalt',
    'dark grey heather', 'dark heather grey', 'dark grey', 'heather charcoal', 'smoke', 'vintage smoke',
    'coal', 'slate', 'steel'],
  'off-white': ['natural', 'ivory', 'sand', 'cream', 'vintage white', 'bone', 'natural heather',
    'heather dust', 'ecru', 'oatmeal', 'stone'],
};
function familiesIn(names) {
  const have = new Set(names.map((n) => n.toLowerCase()));
  return Object.keys(CORE_FAMILIES).filter((f) => CORE_FAMILIES[f].some((n) => have.has(n)));
}
function missingFamilies(c, required) {
  const have = familiesIn(c.colors.map((x) => x.name));
  return required.filter((f) => !have.includes(f));
}
const fmt = (cents) => '$' + (cents / 100).toFixed(2);

export function rankCandidates(cands, wanted, market) {
  const reaches = cands.filter((c) => c.ship);
  const inMarket = reaches.filter((c) => c.local);
  let pool = inMarket.length ? inMarket : reaches;
  const imported = !inMarket.length;
  const reasons = new Map();
  for (const c of reaches) {
    if (!inMarket.length || c.local) continue;
    reasons.set(c.id, 'Ships in from ' + (c.madeIn.length ? c.madeIn.join('/') : 'abroad'));
  }
  const tier = (test, why) => {
    const pass = pool.filter(test);
    if (pass.length) {
      for (const c of pool) if (!pass.includes(c)) reasons.set(c.id, why);
      pool = pass;
    }
  };
  const required = [...new Set(['black', 'white', ...familiesIn(wanted || [])])];
  tier((c) => !missingFamilies(c, required).length, 'missing colours');
  tier((c) => c.rating == null || c.rating >= MIN_RATING, 'Rated under ' + MIN_RATING.toFixed(1));

  const cheapest = pool.reduce((a, c) => (!a || c.landed < a.landed ? c : a), null);
  let pick = pool.find((c) => c.providerId === CHOICE_ID && c.local) || null;
  if (pick) {
    pick.why = 'Printify Choice, prints in ' + market;
  } else if (cheapest) {
    const band = pool.filter((c) => c.landed <= cheapest.landed + UPGRADE_BAND);
    const minDays = Math.min(...band.map((c) => c.delivery));
    const merit = (c) => 0.5 * ((Math.min(10, Math.max(6, c.rating ?? 8)) - 6) / 4) + 0.5 * (minDays / c.delivery);
    pick = band.slice().sort((a, b) => (merit(b) - merit(a)) || (a.landed - b.landed))[0];
    const where = imported ? 'that ships to ' + market : 'in ' + market;
    if (pick === cheapest) {
      pick.why = (imported ? 'No printer in ' + market + '. Cheapest ' : 'Cheapest printer ') + where;
    } else {
      const gains = [];
      const faster = Math.round(cheapest.delivery - pick.delivery);
      if (faster >= 1) gains.push(faster + (faster === 1 ? ' day' : ' days') + ' faster');
      if ((pick.rating ?? 0) > (cheapest.rating ?? 0)) gains.push('rated ' + pick.rating.toFixed(1) + ' vs ' + cheapest.rating.toFixed(1));
      pick.why = (imported ? 'No printer in ' + market + '. ' : '')
        + '+' + fmt(pick.landed - cheapest.landed) + ' over ' + cheapest.name + ': ' + gains.join(', ');
    }
  }

  for (const c of cands) {
    c.eligible = pool.includes(c);
    c.picked = c === pick;
    c.delta = cheapest && c.landed != null ? c.landed - cheapest.landed : null;
    c.reason = !c.ship ? 'Does not ship here' : (reasons.get(c.id) || null);
    if (c.reason === 'missing colours') c.reason = 'No ' + missingFamilies(c, required).join(' or ');
  }
  // The pick first, then the rest of the eligible ones by landed cost, then the excluded.
  return cands.slice().sort((a, b) => (b.picked - a.picked) || (b.eligible - a.eligible)
    || ((a.landed ?? 1e9) - (b.landed ?? 1e9)));
}

// ---- Data ----

// Printify's catalog endpoints are rate limited per minute and a cold load makes a few
// hundred calls, so a 429 is waited out (its Retry-After, else a growing pause) rather
// than treated as a failure.
async function apiGet(path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 3 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(30, wait) * 1000));
      continue;
    }
    if (!res.ok) throw new Error('Printify ' + res.status + ' on ' + path);
    return res.json();
  }
  throw new Error('Printify rate limit on ' + path);
}

// Printify's catalog page data for one blueprint: price, rating, production time, factory
// countries and, per colour, the Global Fulfillment flag. null when it does not answer.
async function siteProviders(blueprintId) {
  try {
    const res = await fetch(SITE + blueprintId + '/print-providers?target_market=' + encodeURIComponent('All markets'),
      { headers: { 'User-Agent': 'Mozilla/5.0 (Backstage)', Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    const out = {};
    for (const p of j.data || []) {
      const colors = ((p.options || []).find((o) => o.type === 'color') || { items: [] }).items;
      // Printify Premium (which these shops are on) is a different, lower price list, so
      // the subscription figure is the real cost; min_price is the list price. Both are
      // the SMALLEST size with ONE print area: cost rises with size, and a back print
      // adds about $5, so the range is carried too and the builder shows it.
      const std = (p.cost_ranges_by_decoration_method_standard || {}).dtg || null;
      const sub = (p.cost_ranges_by_decoration_method_subscription || {}).dtg || null;
      out[p.id] = {
        name: p.name,
        price: p.min_price_subscription ?? p.min_price,
        priceMax: (sub || std || {}).max ?? null,
        listPrice: p.min_price,
        premium: p.min_price_subscription != null,
        // Printify's own per-region rates: what Global Fulfillment, a local printer and an
        // import each cost. The v2 shipping table has no Global Fulfillment row at all.
        regional: Object.fromEntries((p.regional_shipping || []).map((r) => [r.region, {
          local: r.local_fulfillment && r.local_fulfillment.min_shipping_rate,
          global: r.global_fulfillment && r.global_fulfillment.min_shipping_rate,
          imported: r.international_fulfillment && r.international_fulfillment.min_shipping_rate,
        }])),
        rating: p.scoring ? p.scoring.generic_score : null,
        prodDays: p.average_business_days_in_production,
        madeIn: [...new Set((p.facilities || []).map((f) => (f.country_code === 'GB' ? 'UK' : f.country_code)))],
        global: colors.filter((c) => c.fulfillment === 'internationally_optimized').map((c) => c.label),
        hex: Object.fromEntries(colors.map((c) => [c.label, c.colors && c.colors[0] ? c.colors[0].hex : null])),
      };
    }
    return out;
  } catch {
    return null;
  }
}

// Cheapest first-item standard shipping and delivery days to each market, from the v2
// table. A market Printify lists only under "rest of the world" uses that row.
async function shippingByMarket(blueprintId, providerId) {
  let url = '/v2/catalog/blueprints/' + blueprintId + '/print_providers/' + providerId + '/shipping/standard.json';
  const rows = [];
  for (let n = 0; url && n < 30; n++) {
    const page = await apiGet(url);
    rows.push(...(page.data || []));
    url = page.links && page.links.next;
  }
  const out = {};
  for (const m of MARKETS) {
    let match = rows.filter((r) => r.attributes.country.code === m.ship);
    const own = match.length > 0;   // a rate Printify quotes for this market, not the catch-all
    if (!match.length) match = rows.filter((r) => r.attributes.country.code === 'REST_OF_THE_WORLD');
    if (!match.length) continue;
    const a = match.reduce((best, r) =>
      (r.attributes.shippingCost.firstItem.amount < best.shippingCost.firstItem.amount ? r.attributes : best), match[0].attributes);
    out[m.code] = {
      own,
      cost: a.shippingCost.firstItem.amount,
      extra: a.shippingCost.additionalItems.amount,
      from: a.handlingTime ? a.handlingTime.from : null,
      to: a.handlingTime ? a.handlingTime.to : null,
    };
  }
  return out;
}

async function inStockVariants(blueprintId, providerId) {
  const d = await apiGet('/v1/catalog/blueprints/' + blueprintId + '/print_providers/' + providerId + '/variants.json');
  return d.variants || [];
}

async function cached(key, load, fresh = false) {
  const hit = fresh ? null : await getInsightsCache(key).catch(() => null);
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < CACHE_TTL_MS) return hit.data;
  const data = await load();
  if (data) await putInsightsCache(key, data).catch(() => {});
  return data;
}

// Everything about one blueprint's printers. Cached per blueprint (its printer list and
// catalog-page data) and per printer, so a cold load that runs into the rate limit keeps
// what it got and the next load picks up where it stopped. Nothing failed is cached.
async function blueprintData(blueprintId, fresh = false) {
  const head = await cached('printify_bp2_' + blueprintId, async () => {
    const [list, bp, site] = await Promise.all([
      apiGet('/v1/catalog/blueprints/' + blueprintId + '/print_providers.json'),
      apiGet('/v1/catalog/blueprints/' + blueprintId + '.json'),
      siteProviders(blueprintId),
    ]);
    if (!site) return null;
    return { list: list.map((p) => ({ id: p.id, title: p.title })), blank: (bp.brand + ' ' + bp.model).trim(), site };
  }, fresh);
  // The catalog pages did not answer: carry on with the API alone, uncached.
  const h = head || await (async () => {
    const list = await apiGet('/v1/catalog/blueprints/' + blueprintId + '/print_providers.json');
    const bp = await apiGet('/v1/catalog/blueprints/' + blueprintId + '.json');
    return { list, blank: (bp.brand + ' ' + bp.model).trim(), site: {}, noSite: true };
  })();

  let failed = !head;
  const providers = {};
  for (let i = 0; i < h.list.length; i += 2) {
    await Promise.all(h.list.slice(i, i + 2).map(async (p) => {
      try {
        const s = h.site[p.id] || {};
        const entry = await cached('printify_pp2_' + blueprintId + '_' + p.id, async () => {
          const [ship, variants] = await Promise.all([shippingByMarket(blueprintId, p.id), inStockVariants(blueprintId, p.id)]);
          return {
            ship,
            colors: groupByColor(variants),
            backCapable: variants.some((v) => (v.placeholders || []).some((ph) => ph.position === 'back')),
            empty: !variants.length,
          };
        }, fresh);
        if (entry.empty) return;
        providers[p.id] = {
          id: p.id, name: s.name || p.title, price: s.price ?? null, priceMax: s.priceMax ?? null,
          listPrice: s.listPrice ?? null, premium: !!s.premium, regional: s.regional || {},
          rating: s.rating ?? null,
          prodDays: s.prodDays ?? null, madeIn: s.madeIn || [], global: s.global || [],
          ship: entry.ship, backCapable: entry.backCapable,
          colors: entry.colors.map((c) => ({ ...c, hex: c.hex || (s.hex && s.hex[c.name]) || null })),
        };
      } catch {
        failed = true;
      }
    }));
  }
  return { blueprintId, blank: h.blank, providers, partial: failed, noSite: !!h.noSite };
}

// ---- Products ----

// Every product the builder can make, adults and kids, in one shape.
function slotsFor(group) {
  if (group === 'adults') {
    return GARMENT_ORDER.map((k) => ({
      key: k, label: VARIANTS[k].label, titleSuffix: VARIANTS[k].title_suffix,
      blueprints: VARIANTS[k].blueprints || [VARIANTS[k].blueprint_id],
      defaults: VARIANTS[k].colors, global: !!VARIANTS[k].global,
    }));
  }
  return KIDS_CATALOG.map((g) => ({
    key: g.key, label: g.label, blurb: g.blurb, titleSuffix: g.titleSuffix,
    blueprints: g.blueprints, defaults: g.colors, global: false,
  }));
}

function findSlot(group, key) {
  const s = slotsFor(group).find((x) => x.key === key);
  if (!s) throw new Error('Unknown product "' + key + '".');
  return s;
}

// The product_config row a listing takes its price and tags from. Adult markets share
// the garment's row; kids have one row per market (onesie_us, onesie_uk, ...).
export function configKey(group, slotKey, market) {
  return group === 'kids' ? slotKey + '_' + MARKETS.find((m) => m.code === market).tag : slotKey;
}

function defaultsFor(slot, colors) {
  const have = new Set(colors.map((c) => c.name.toLowerCase()));
  const picked = slot.defaults.filter((c) => have.has(c.toLowerCase()));
  return picked.length ? picked : CORE_COLOURS.filter((c) => have.has(c.toLowerCase()));
}

function candidateFor(bpData, p, market) {
  const ship = p.ship[market.code] || null;
  return {
    id: bpData.blueprintId + ':' + p.id, providerId: p.id, blueprintId: bpData.blueprintId,
    blank: bpData.blank, name: p.name, madeIn: p.madeIn,
    // Shipped from inside the market: Printify quotes this market its own rate AND the
    // lane is a domestic one. The printer's factory list is NOT the test, because a
    // factory is only reachable on a regular listing when Printify bills its local rate
    // (Printify Choice has UK and AU factories but bills both as cross-border there).
    local: !!(ship && ship.own && ship.to != null && ship.to <= DOMESTIC_MAX_DAYS),
    rating: p.rating, prodDays: p.prodDays, base: p.price, baseMax: p.priceMax, premium: p.premium,
    colors: p.colors, backCapable: p.backCapable,
    ship: ship ? { cost: ship.cost, from: ship.from, to: ship.to } : null,
    landed: ship ? (p.price || 0) + ship.cost : null,
    delivery: ship ? (p.prodDays || 2) + (ship.to || 30) : null,
  };
}

// What the builder shows, from the weekly saved copy. Only when that copy is missing or
// too old is it rebuilt here, which is the one slow load.
export async function builderCatalog(group) {
  const hit = await getInsightsCache('printify_catalog2_' + group).catch(() => null);
  if (hit && Date.now() - new Date(hit.fetchedAt).getTime() < CACHE_TTL_MS) {
    return { ...hit.data, checkedAt: new Date(hit.fetchedAt).toISOString() };
  }
  return refreshCatalog(group);
}

// Rebuild the saved copy from Printify. `fresh` re-reads every printer rather than reusing
// the per-printer cache, which is what the weekly cron does. A copy with a printer that
// did not answer is returned but not saved, so the next load tries again.
export async function refreshCatalog(group, fresh = false) {
  const data = await computeCatalog(group, fresh);
  if (!data.products.some((p) => p.partial || p.error || p.globalMissing)) {
    await putInsightsCache('printify_catalog2_' + group, data).catch(() => {});
  }
  return data;
}

// For each product its listings, the Global Fulfillment one first where the garment has
// it, then one per market with every printer ranked and the pick marked. `on` is whether
// the listing starts ticked.
async function computeCatalog(group, fresh) {
  if (!process.env.PRINTIFY_TOKEN) throw new Error('PRINTIFY_TOKEN is not set.');
  const slots = slotsFor(group);
  const ids = [...new Set(slots.flatMap((s) => s.blueprints))];
  const data = {};
  for (let i = 0; i < ids.length; i += 3) {
    await Promise.all(ids.slice(i, i + 3).map(async (id) => {
      try { data[id] = await blueprintData(id, fresh); } catch (err) { data[id] = { error: String(err.message || err) }; }
    }));
  }

  const products = slots.map((slot) => {
    const bps = slot.blueprints.map((id) => data[id]).filter((d) => d && !d.error);
    if (!bps.length) return { key: slot.key, label: slot.label, blurb: slot.blurb, error: (data[slot.blueprints[0]] || {}).error || 'No data' };
    const partial = bps.some((d) => d.partial);

    // Per-market listings exist for every product, but two kinds start unticked, so both
    // are opted into rather than out of: a Global Fulfillment garment's markets (they are
    // for a market-specific design, not the default), and any market with no printer of
    // its own, where the only way to sell is a 3-4 week import.
    const markets = MARKETS.map((m) => {
      const cands = rankCandidates(bps.flatMap((d) => Object.values(d.providers).map((p) => candidateFor(d, p, m))), slot.defaults, m.code);
      const pick = cands.find((c) => c.picked) || null;
      const imported = !!pick && !pick.local;
      return {
        market: m.code, label: m.label, tags: [m.tag], candidates: cands, imported,
        on: !slot.global && !!pick && !imported,
        pick: pick ? pick.id : null, defaults: pick ? defaultsFor(slot, pick.colors) : [],
      };
    });

    let global = null;
    if (slot.global) {
      const choice = bps[0].providers[CHOICE_ID];
      const eligible = choice ? new Set(choice.global.map((n) => n.toLowerCase())) : new Set();
      const colors = choice ? choice.colors.filter((c) => eligible.has(c.name.toLowerCase())) : [];
      if (colors.length) {
        // Global Fulfillment has its own shipping rate, the same in every market, and it
        // is NOT in the v2 shipping table (which only knows US/CA/AU/rest-of-world and
        // would price the UK as an import). Printify publishes it per region instead.
        const gf = Object.values(choice.regional || {})
          .map((r) => r.global).filter((n) => n != null);
        const rate = gf.length ? Math.max(...gf) : null;
        const cand = { ...candidateFor(bps[0], choice, MARKETS[0]), colors, eligible: true, picked: true,
          why: 'Printed locally in every market', local: true };
        if (rate != null) {
          cand.ship = { own: true, cost: rate, from: cand.ship ? cand.ship.from : 2, to: cand.ship ? cand.ship.to : 5 };
          cand.landed = (cand.base || 0) + rate;
        }
        global = {
          market: GLOBAL, label: 'Global fulfillment', tags: MARKETS.map((m) => m.tag), on: true,
          candidates: [cand], pick: cand.id, defaults: defaultsFor(slot, colors),
        };
      } else {
        // Eligibility comes from Printify's catalog pages; without them, or with no
        // eligible colours, the markets are the only way to list it, so tick them.
        for (const m of markets) m.on = true;
      }
    }

    // A printer's colours are the same in every market, so they travel once per product
    // (`printers`) rather than once per market: the payload is a quarter the size, which
    // matters on a phone. Candidates keep a count for display.
    const printers = {};
    for (const m of markets) {
      for (const c of m.candidates) {
        printers[c.id] = c.colors;
        c.colorCount = c.colors.length;
        delete c.colors;
      }
    }

    return {
      key: slot.key, label: slot.label, blurb: slot.blurb, partial,
      globalCapable: slot.global, globalMissing: slot.global && !global,
      printers, listings: global ? [global, ...markets] : markets,
    };
  });
  return { products, checkedAt: new Date().toISOString() };
}

// ---- Building ----

async function createProduct(shopId, body) {
  const res = await fetch(API + '/v1/shops/' + shopId + '/products.json', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Create failed (' + res.status + '): ' + (await res.text()));
  return res.json();
}

// One product, every picked market (or its one Global Fulfillment listing).
// payload = { group, shopId, key, designName, description, frontId, backId, placement,
//             listings: [{ market: 'US'|..|'GLOBAL', providerId, blueprintId, colors: [...] }] }
export async function buildProduct(payload) {
  const { group, shopId, key, frontId, backId, placement } = payload;
  const slot = findSlot(group, key);
  if (!frontId) throw new Error('Missing the uploaded front image id.');
  const designName = String(payload.designName || '').trim();
  const store = await getStoreByShopId(String(shopId || '').trim());
  if (!store) throw new Error('Pick a valid store (got shop id "' + shopId + '").');
  const config = await getProductConfig(store.brand_key);

  const results = [];
  const warnings = [];
  for (const l of payload.listings || []) {
    const isGlobal = l.market === GLOBAL;
    const market = MARKETS.find((m) => m.code === l.market);
    const tagLabel = isGlobal ? 'Global' : l.market;
    const label = slot.label + ' ' + tagLabel;
    try {
      if (!isGlobal && !market) throw new Error('Unknown market ' + l.market);
      if (isGlobal && !slot.global) throw new Error(slot.label + ' has no Global Fulfillment.');
      const blueprintId = Number(l.blueprintId);
      const providerId = isGlobal ? CHOICE_ID : Number(l.providerId);
      if (!slot.blueprints.includes(blueprintId)) throw new Error('Blueprint ' + blueprintId + ' is not a ' + slot.label + '.');

      let picked = Array.isArray(l.colors) && l.colors.length ? l.colors : slot.defaults;
      // Global Fulfillment is all or nothing, so re-check eligibility at build time
      // rather than trusting what the page loaded earlier.
      if (isGlobal) {
        const site = await siteProviders(blueprintId);
        const choice = site && site[CHOICE_ID];
        if (!choice) throw new Error('Could not confirm Global Fulfillment eligibility with Printify, so nothing was built.');
        const ok = new Set(choice.global.map((n) => n.toLowerCase()));
        const dropped = picked.filter((c) => !ok.has(c.toLowerCase()));
        if (dropped.length) {
          warnings.push(label + ': ' + dropped.join(', ') + ' no longer eligible for Global Fulfillment, so left off.');
          picked = picked.filter((c) => ok.has(c.toLowerCase()));
        }
      }

      const want = new Set(picked.map((c) => c.toLowerCase()));
      const variants = await inStockVariants(blueprintId, providerId);
      const matched = variants.filter((v) => v.options && want.has(String(v.options.color).toLowerCase()));
      const found = new Set(matched.map((v) => String(v.options.color).toLowerCase()));
      const missing = picked.filter((c) => !found.has(c.toLowerCase()));
      if (missing.length) warnings.push(label + ': ' + missing.join(', ') + ' not in stock with this printer, so skipped.');
      if (!matched.length) {
        results.push({ label, market: l.market, ok: false, error: 'None of the picked colours are in stock with this printer.' });
        continue;
      }
      const variantIds = matched.map((v) => v.id);

      const placeholders = [{ position: 'front', images: [{ id: frontId, ...placement }] }];
      if (backId) {
        const hasBack = matched.some((v) => (v.placeholders || []).some((ph) => ph.position === 'back'));
        if (hasBack) placeholders.push({ position: 'back', images: [{ id: backId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
        else warnings.push(label + ': this printer has no back print area, so the back design was left off.');
      }

      const cKey = isGlobal ? slot.key : configKey(group, slot.key, l.market);
      const cfg = config[cKey] || { price_cents: GENERIC_PRICE_CENTS, tags: [] };
      if (!config[cKey]) {
        warnings.push('No price or tags set for ' + cKey + '. Used $' + (GENERIC_PRICE_CENTS / 100).toFixed(2) + '. Set it in Settings.');
      }
      const tags = cfg.tags.slice();
      const marketTags = isGlobal ? MARKETS.map((m) => m.tag) : [market.tag];
      for (const t of marketTags) if (!tags.includes(t)) tags.push(t);
      if (group === 'adults' && !UPSELL_EXEMPT.includes(slot.key) && !tags.includes(UPSELL_TAG)) tags.push(UPSELL_TAG);

      const title = designName + slot.titleSuffix + (isGlobal ? '' : ' (' + l.market + ')');
      const created = await createProduct(shopId, {
        title, description: payload.description || '', blueprint_id: blueprintId, print_provider_id: providerId,
        tags,
        variants: variantIds.map((id) => ({ id, price: cfg.price_cents, is_enabled: true })),
        print_areas: [{ variant_ids: variantIds, placeholders }],
      });
      results.push({ label, market: l.market, ok: true, productId: created.id, title,
        colors: found.size, variants: variantIds.length, tags: marketTags });
    } catch (err) {
      results.push({ label, market: l.market, ok: false, error: String(err.message || err) });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { key: slot.key, label: slot.label, results, warnings };
}

// Settings lists one price/tag row per product a build can make.
export function configRows() {
  // Adult listings share one row per garment, Global and every market alike.
  const adults = GARMENT_ORDER.map((k) => ({ key: k, label: VARIANTS[k].label, group: 'Adults' }));
  const kids = KIDS_CATALOG.flatMap((g) => MARKETS.map((m) => ({ key: g.key + '_' + m.tag, label: g.label + ' (' + m.code + ')', group: 'Kids' })));
  return [...adults, ...kids];
}

