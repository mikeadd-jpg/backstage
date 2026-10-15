// Kids garments: the list, and their descriptions. No kids blueprint has Printify Choice
// Global Fulfillment, so every kids garment is built as one listing per market, each with
// the printer lib/printers.js ranks best there (overridable in the builder).
//
// Colours are stored as NAMES and resolved to variant ids at build time, because each
// printer stocks a different set (the same toddler tee is 18 colours in the US and 8 in
// the UK). `colors` is only where the picker starts.
import Anthropic from '@anthropic-ai/sdk';
import { getStoreByShopId, getVoiceRow } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';
import { prepareImage, uploadImage } from './builder.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';

// `blueprints` lists every Printify blueprint that can fill the slot; the ranking may
// pick a different one per market.
export const KIDS_CATALOG = [
  {
    key: 'onesie',
    label: 'Onesie',
    titleSuffix: ' Onesie',
    blurb: 'Rabbit Skins 4424 infant fine jersey bodysuit',
    colors: ['Black', 'Butter', 'Charcoal', 'Heather', 'Light Blue', 'Navy', 'Pink', 'Red', 'White'],
    blueprints: [33],
  },
  {
    // No long sleeve infant bodysuit has a UK or Australian printer, so those markets
    // get one that ships in from abroad. Printify Choice does not carry blueprint 31.
    key: 'ls_bodysuit',
    label: 'Long Sleeve Bodysuit',
    titleSuffix: ' Long Sleeve Bodysuit',
    blurb: 'Rabbit Skins 4411 infant long sleeve bodysuit',
    colors: ['Black', 'Heather', 'Light Blue', 'Pink', 'White'],
    blueprints: [31],
  },
  {
    key: 'baby_tee',
    label: 'Baby Tee',
    titleSuffix: ' Baby Tee',
    blurb: 'Rabbit Skins 3322 infant fine jersey tee',
    colors: ['Apple', 'Black', 'Butter', 'Charcoal', 'Heather', 'Light Blue', 'Navy', 'Pink', 'Red', 'White'],
    blueprints: [34],
  },
  {
    // Bella+Canvas 3001T is US-only, so outside the US the slot is filled by Rabbit
    // Skins 3321. Two blueprints, one slot: the ranking compares printers across both.
    key: 'toddler_tee',
    label: 'Toddler Tee',
    titleSuffix: ' Toddler Tee',
    blurb: 'toddler fine jersey tee (Bella+Canvas 3001T or Rabbit Skins 3321)',
    colors: ['Black', 'Navy', 'Pink', 'White'],
    blueprints: [580, 32],
  },
  {
    key: 'youth_tee',
    label: 'Youth Tee',
    titleSuffix: ' Youth Tee',
    blurb: 'Gildan 5000B heavy cotton youth tee',
    colors: ['Ash', 'Black', 'Forest Green', 'Heliconia', 'Irish Green', 'Light Blue',
             'Light Pink', 'Lime', 'Navy', 'Purple', 'Red', 'Royal', 'Sport Grey', 'White'],
    blueprints: [157],
  },
];

export const KIDS_GROUP_KEYS = KIDS_CATALOG.map((g) => g.key);

export function kidsGroup(key) {
  return KIDS_CATALOG.find((g) => g.key === key) || null;
}

// The brand voice for a store, used when generating the kids descriptions.
export async function kidsVoice(shopId) {
  const store = await getStoreByShopId(String(shopId || '').trim());
  if (!store) throw new Error('Pick a valid store.');
  return { store, voice: (await getVoiceRow(store.brand_key)) || fallbackVoice(store.brand_key) };
}

// One description per garment, reused across its markets: a US and a UK
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

// Step 1 of a kids build: upload the design once and write the descriptions. The client
// then calls buildProduct (lib/printers.js) once per garment.
export async function prepareKids(body) {
  if (!process.env.PRINTIFY_TOKEN) throw new Error('PRINTIFY_TOKEN is not set.');
  const designName = String(body.designName || '').trim();
  if (!designName) throw new Error('Design name is required.');
  if (!body.frontB64) throw new Error('A front design is required.');

  const { store, voice } = await kidsVoice(body.shopId);
  const warnings = [];

  const front = await prepareImage(body.frontB64, body.frontName || 'front.png', 'The front design');
  if (front.note) warnings.push(front.note);
  const frontId = await uploadImage(front.b64, front.fileName);

  let backId = null;
  if (body.backB64) {
    const back = await prepareImage(body.backB64, body.backName || 'back.png', 'The back design');
    if (back.note) warnings.push(back.note);
    backId = await uploadImage(back.b64, back.fileName);
  }

  const generated = await generateKidsDescriptions(voice, designName, body.vibe);
  const descriptions = {};
  for (const g of KIDS_CATALOG) descriptions[g.key] = generated[g.key] || kidsFallbackDesc(designName, g.key);
  if (!Object.keys(generated).length) {
    warnings.push('Could not generate descriptions, so each product got a placeholder line. Edit them in Printify.');
  }
  return { storeName: store.name, frontId, backId, descriptions, warnings };
}
