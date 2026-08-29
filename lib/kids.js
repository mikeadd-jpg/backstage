// Kids product builder. One design becomes a region-specific product for every kids
// garment, because Printify Choice cannot fulfil these blueprints for UK and Canada.
// Each region therefore names its own print provider explicitly.
//
// Variant ids are NOT hardcoded the way lib/builder.js does it for adults. A kids
// garment has a different variant set per provider (the same toddler tee is 18 colors
// in the US and 8 in the UK), so we store colour NAMES here and resolve them to ids
// against the catalog at build time. That survives Printify adding or retiring stock.
import Anthropic from '@anthropic-ai/sdk';
import { getProductConfig, getStoreByShopId, getVoiceRow } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';

const PRINTIFY_BASE = 'https://api.printify.com/v1';

// Region -> print provider, per garment. Verified against the catalog on 2026-08-28.
//   US uses Printify Choice (99) wherever it exists, matching the adult products.
//   UK and CA must name a real provider, which is the whole point of this feature.
export const KIDS_CATALOG = [
  {
    key: 'onesie',
    label: 'Onesie',
    titleSuffix: ' Onesie',
    blurb: 'Rabbit Skins 4424 infant fine jersey bodysuit',
    colors: ['Black', 'Butter', 'Charcoal', 'Heather', 'Light Blue', 'Navy', 'Pink', 'Red', 'White'],
    regions: [
      { region: 'US', garmentKey: 'onesie_us', blueprintId: 33, printProviderId: 99 },
      { region: 'UK', garmentKey: 'onesie_uk', blueprintId: 33, printProviderId: 6 },
      { region: 'CA', garmentKey: 'onesie_ca', blueprintId: 33, printProviderId: 27 },
    ],
  },
  {
    // No long sleeve infant bodysuit on Printify has a UK provider, so this one is
    // US and CA only. Its US provider is SwiftPOD because Printify Choice does not
    // carry blueprint 31, and its CA provider is Duplium because Print Geek stocks
    // only 4 variants of it (Navy and Red, no black or white).
    key: 'ls_bodysuit',
    label: 'Long Sleeve Bodysuit',
    titleSuffix: ' Long Sleeve Bodysuit',
    blurb: 'Rabbit Skins 4411 infant long sleeve bodysuit',
    colors: ['Black', 'Heather', 'Light Blue', 'Pink', 'White'],
    regions: [
      { region: 'US', garmentKey: 'ls_bodysuit_us', blueprintId: 31, printProviderId: 39 },
      { region: 'CA', garmentKey: 'ls_bodysuit_ca', blueprintId: 31, printProviderId: 41 },
    ],
  },
  {
    key: 'baby_tee',
    label: 'Baby Tee',
    titleSuffix: ' Baby Tee',
    blurb: 'Rabbit Skins 3322 infant fine jersey tee',
    colors: ['Apple', 'Black', 'Butter', 'Charcoal', 'Heather', 'Light Blue', 'Navy', 'Pink', 'Red', 'White'],
    regions: [
      { region: 'US', garmentKey: 'baby_tee_us', blueprintId: 34, printProviderId: 99 },
      { region: 'UK', garmentKey: 'baby_tee_uk', blueprintId: 34, printProviderId: 6 },
      { region: 'CA', garmentKey: 'baby_tee_ca', blueprintId: 34, printProviderId: 27 },
    ],
  },
  {
    // The US toddler tee is Bella+Canvas 3001T, which has no UK or CA provider at all,
    // so those regions fall back to Rabbit Skins 3321. Different blueprint, same slot.
    key: 'toddler_tee',
    label: 'Toddler Tee',
    titleSuffix: ' Toddler Tee',
    blurb: 'Bella+Canvas 3001T in the US, Rabbit Skins 3321 in the UK and Canada',
    colors: ['Black', 'Navy', 'Pink', 'White'],
    regions: [
      { region: 'US', garmentKey: 'toddler_tee_us', blueprintId: 580, printProviderId: 99 },
      { region: 'UK', garmentKey: 'toddler_tee_uk', blueprintId: 32, printProviderId: 6 },
      { region: 'CA', garmentKey: 'toddler_tee_ca', blueprintId: 32, printProviderId: 27 },
    ],
  },
  {
    key: 'youth_tee',
    label: 'Youth Tee',
    titleSuffix: ' Youth Tee',
    blurb: 'Gildan 5000B heavy cotton youth tee',
    colors: ['Ash', 'Black', 'Forest Green', 'Heliconia', 'Irish Green', 'Light Blue',
             'Light Pink', 'Lime', 'Navy', 'Purple', 'Red', 'Royal', 'Sport Grey', 'White'],
    regions: [
      { region: 'US', garmentKey: 'youth_tee_us', blueprintId: 157, printProviderId: 99 },
      { region: 'UK', garmentKey: 'youth_tee_uk', blueprintId: 157, printProviderId: 331 },
      { region: 'CA', garmentKey: 'youth_tee_ca', blueprintId: 157, printProviderId: 27 },
    ],
  },
];

export const KIDS_GROUP_KEYS = KIDS_CATALOG.map((g) => g.key);
const GENERIC_PRICE_CENTS = 2499;

// Flat list for the Settings tab: one row per product we can create.
export function kidsGarmentList() {
  const out = [];
  for (const g of KIDS_CATALOG) {
    for (const r of g.regions) {
      out.push({ key: r.garmentKey, label: g.label + ' (' + r.region + ')', group: 'Kids' });
    }
  }
  return out;
}

export function kidsGroup(key) {
  return KIDS_CATALOG.find((g) => g.key === key) || null;
}

// Resolve colour names to variant ids for one blueprint + provider, and report which
// print positions that provider actually offers. Print Geek, for example, exposes only
// a front area on the infant and toddler blueprints, so a back design cannot be placed.
export async function resolveVariants(blueprintId, printProviderId, colors) {
  const res = await fetch(
    PRINTIFY_BASE + '/catalog/blueprints/' + blueprintId + '/print_providers/' + printProviderId + '/variants.json',
    { headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN } }
  );
  if (!res.ok) throw new Error('Catalog lookup failed (' + res.status + ') for blueprint ' + blueprintId + ' provider ' + printProviderId);
  const data = await res.json();
  const all = data.variants || [];

  const wanted = new Set(colors.map((c) => c.toLowerCase()));
  const matched = all.filter((v) => {
    const c = v.options && v.options.color;
    return c && wanted.has(String(c).toLowerCase());
  });

  const positions = new Set();
  for (const p of (matched[0] || all[0] || {}).placeholders || []) positions.add(p.position);

  const foundColors = new Set(matched.map((v) => String(v.options.color).toLowerCase()));
  const missing = colors.filter((c) => !foundColors.has(c.toLowerCase()));

  return { variantIds: matched.map((v) => v.id), positions, missing, totalAvailable: all.length };
}

async function createProduct(shopId, body) {
  const res = await fetch(PRINTIFY_BASE + '/shops/' + shopId + '/products.json', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Create failed (' + res.status + '): ' + (await res.text()));
  return res.json();
}

// Build every region of ONE garment group. The client calls this once per group so each
// request stays well inside the 60 second function limit on Vercel's Hobby plan.
export async function buildKidsGroup(payload) {
  const { shopId, groupKey, designName, description, frontId, backId, placement, regions } = payload;
  const group = kidsGroup(groupKey);
  if (!group) throw new Error('Unknown kids garment group "' + groupKey + '".');
  if (!frontId) throw new Error('Missing the uploaded front image id.');

  const store = await getStoreByShopId(String(shopId || '').trim());
  if (!store) throw new Error('Pick a valid store (got shop id "' + shopId + '").');
  const config = await getProductConfig(store.brand_key);

  const results = [];
  const warnings = [];

  // regions is an optional allow-list from the builder's checkboxes. Omitted means all.
  const wanted = Array.isArray(regions) && regions.length ? new Set(regions) : null;
  const targets = wanted ? group.regions.filter((r) => wanted.has(r.region)) : group.regions;

  for (const r of targets) {
    try {
      const { variantIds, positions, missing } = await resolveVariants(
        r.blueprintId, r.printProviderId, group.colors
      );
      if (!variantIds.length) {
        results.push({ label: group.label + ' ' + r.region, region: r.region, ok: false,
          error: 'No variants matched the colour list for this provider.' });
        continue;
      }
      if (missing.length) {
        warnings.push(group.label + ' ' + r.region + ': ' + missing.join(', ') +
          ' not stocked by this provider, so those colours were skipped.');
      }

      const placeholders = [{ position: 'front', images: [{ id: frontId, ...placement }] }];
      if (backId) {
        if (positions.has('back')) {
          placeholders.push({ position: 'back', images: [{ id: backId, x: 0.5, y: 0.5, scale: 1, angle: 0 }] });
        } else {
          warnings.push(group.label + ' ' + r.region +
            ': this provider offers no back print area, so the back design was left off.');
        }
      }

      const cfg = config[r.garmentKey] || { price_cents: GENERIC_PRICE_CENTS, tags: [] };
      if (!config[r.garmentKey]) {
        warnings.push('No price or tags set for ' + r.garmentKey + '. Used $' +
          (GENERIC_PRICE_CENTS / 100).toFixed(2) + ' and no tags. Set it in Settings.');
      }

      const created = await createProduct(shopId, {
        title: designName + group.titleSuffix + ' (' + r.region + ')',
        description,
        blueprint_id: r.blueprintId,
        print_provider_id: r.printProviderId,
        tags: cfg.tags.slice(),
        variants: variantIds.map((id) => ({ id, price: cfg.price_cents, is_enabled: true })),
        print_areas: [{ variant_ids: variantIds, placeholders }],
      });
      results.push({ label: group.label + ' ' + r.region, region: r.region, ok: true,
        productId: created.id, variants: variantIds.length });
    } catch (err) {
      results.push({ label: group.label + ' ' + r.region, region: r.region, ok: false,
        error: String(err.message || err) });
    }
    await new Promise((res) => setTimeout(res, 400));
  }

  return { groupKey, label: group.label, results, warnings };
}

// The brand voice for a store, used when generating the kids descriptions.
export async function kidsVoice(shopId) {
  const store = await getStoreByShopId(String(shopId || '').trim());
  if (!store) throw new Error('Pick a valid store.');
  return { store, voice: (await getVoiceRow(store.brand_key)) || fallbackVoice(store.brand_key) };
}

// One description per garment group, reused across that group's regions: a US and a UK
// onesie are the same product to a shopper, so they get the same copy.
export async function generateKidsDescriptions(voice, designName, vibe) {
  const lines = KIDS_CATALOG.map((g) => '- ' + g.key + ': ' + g.label + ', ' + g.blurb).join('\n');
  const userMsg =
    'Design name: "' + designName + '"\n' + (vibe ? 'Design vibe / notes: ' + vibe + '\n' : '') + '\n' +
    'Write a product description for each of these kids garments:\n' + lines + '\n\n' +
    'These are childrens and baby clothes, so the buyer is a parent, grandparent, or ' +
    'someone buying a gift, not the wearer. Write to them. Rules: lead with the feeling ' +
    'or idea of the design, add one concrete nod to the garment, 2 to 3 sentences each, ' +
    'under 320 characters, no emojis, no markdown, no generic ecommerce filler. Return ' +
    'ONLY valid JSON, no code fences, exactly:\n' +
    '{' + KIDS_CATALOG.map((g) => '"' + g.key + '":"..."').join(',') + '}';

  try {
    const res = await anthropic.messages.create({
      model: DRAFT_MODEL, max_tokens: 1024,
      system: voice + '\n\nYou are writing kids and baby apparel product descriptions in this brand voice.',
      messages: [{ role: 'user', content: userMsg }],
    });
    const txt = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(txt.replace(/```json/gi, '').replace(/```/g, '').trim());
  } catch {
    return {};
  }
}

export function kidsFallbackDesc(designName, groupKey) {
  const g = kidsGroup(groupKey);
  return '"' + designName + '" on a ' + (g ? g.blurb : 'kids garment') + '. Edit this line in Printify if you want.';
}
