// Printify 5-product builder, ported from the Apps Script version.
// Upload one design (front + optional back), pick a store, create 5 DRAFT products:
// Gildan Tee, Comfort Colors Tee, Tank, Women's Tee, Crop. Prices, tags, and the brand
// voice come from Postgres (editable in Settings). Descriptions are generated in the
// store's shared brand voice.
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { getStoreByShopId, getProductConfig, getVoiceRow } from './db.js';
import { brandVoice as fallbackVoice } from './brands.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DRAFT_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';
const PRINTIFY_BASE = 'https://api.printify.com/v1';

// Printify rasterizes an uploaded SVG at whatever pixel size the file's own header
// declares, and stores it as a PNG. A vector exported at 155x85 therefore becomes a
// 155x85 print file, which Printify then upscales to fill the print area. Uploading
// "a vector" buys you nothing. So we rasterize here instead, at print resolution.
// 4800px on the long edge is 300 DPI across a 16 inch print area, the largest of the
// five garments. Raster uploads are passed through untouched: upscaling a PNG adds
// no detail, it only makes the file bigger.
const RASTER_LONG_EDGE = Number(process.env.BUILDER_RASTER_PX || 4800);
const MIN_RASTER_LONG_EDGE = 2400;

// Placement presets (center point x/y in 0-1, scale = fraction of print width).
export const PLACEMENT_FULL = { x: 0.5, y: 0.5, scale: 1.0, angle: 0 };
export const PLACEMENT_LEFT_CHEST = { x: 0.82, y: 0.18, scale: 0.22, angle: 0 };

const GENERIC_PRICE_CENTS = 2499;
const UPSELL_TAG = 'upsellprod';
const UPSELL_EXEMPT = ['gildan_tee'];
export const GARMENT_ORDER = ['gildan_tee', 'comfort_colors_tee', 'tank', 'womens_tee', 'crop'];

// Shared garment catalog (global Printify IDs, same for every store). Do not edit lightly.
const VARIANTS = {
  gildan_tee: {
    label: 'Gildan Tee', blueprint_id: 6, print_provider_id: 99, title_suffix: ' Tee',
    variant_ids: [
      12126, 12125, 12124, 12127, 12128, 12129, 24039, 24171,
      12102, 12101, 12100, 12103, 12104, 12105, 24031, 24164,
      11988, 11987, 11986, 11989, 11990, 11991, 23993, 24126,
      11874, 11873, 11872, 11875, 11876, 11877, 23955, 24088,
      11982, 11981, 11980, 11983, 11984, 11985, 23991, 24124,
    ],
  },
  comfort_colors_tee: {
    label: 'Comfort Colors Tee', blueprint_id: 706, print_provider_id: 99, title_suffix: ' Tee on Comfort Colors',
    variant_ids: [
      73196, 73200, 73204, 73208, 73212, 79114, 101423,
      73199, 73203, 73207, 73211, 73215, 79169, 101476,
      79081, 79082, 79083, 79084, 79085, 79164, 101471,
      79046, 79047, 79048, 79049, 79050, 79155, 101463,
      78991, 78992, 78993, 78994, 78995, 79142, 101450,
    ],
  },
  tank: {
    label: 'Tank', blueprint_id: 880, print_provider_id: 99, title_suffix: ' Tank',
    variant_ids: [
      76974, 76980, 76986, 76992, 76998,
      76973, 76979, 76985, 76991, 76997,
      76969, 76975, 76981, 76993,
      112103, 112108, 112113, 112118, 112123,
    ],
  },
  womens_tee: {
    label: "Women's Tee", blueprint_id: 88, print_provider_id: 99, title_suffix: " - Women's Tee",
    variant_ids: [
      33843, 33856, 33869, 33882, 33895,
      33841, 33854, 33867, 33880, 33893,
      33836, 33849, 33862, 33875, 33888,
      42125, 42129, 42133, 42137, 42141,
    ],
  },
  crop: {
    label: 'Crop', blueprint_id: 1393, print_provider_id: 99, title_suffix: ' Crop',
    variant_ids: [
      115088, 115089, 115090, 115091, 115092,
      120697, 120698, 120699, 120701,
      103846, 103847, 103848, 103849, 103850,
      103836, 103837, 103838, 103839, 103840,
    ],
  },
};

const GARMENT_DESC = {
  gildan_tee: 'classic unisex cotton tee',
  comfort_colors_tee: 'heavyweight garment-dyed tee with a vintage hand',
  tank: 'sleeveless tank',
  womens_tee: "fitted women's tee",
  crop: 'cropped, boxy women\'s tee',
};

export function garmentList() {
  return GARMENT_ORDER.map((k) => ({ key: k, label: VARIANTS[k].label, group: 'Adults' }));
}

function isSvg(buf, fileName) {
  if (/\.svg$/i.test(fileName || '')) return true;
  // Sniff the head, since a vector exported with the wrong extension is common.
  return /<svg[\s>]/i.test(buf.slice(0, 1024).toString('utf8'));
}

// Returns { b64, fileName, note }. note is a user-facing warning, or null.
export async function prepareImage(b64, fileName, label) {
  const buf = Buffer.from(b64, 'base64');

  if (!isSvg(buf, fileName)) {
    try {
      const m = await sharp(buf).metadata();
      const longEdge = Math.max(m.width || 0, m.height || 0);
      if (longEdge && longEdge < MIN_RASTER_LONG_EDGE) {
        return { b64, fileName, note: label + ' is only ' + m.width + 'x' + m.height +
          'px. Printify will upscale it to fill the print area and it will look soft. ' +
          'Re-export at ' + RASTER_LONG_EDGE + 'px on the long edge.' };
      }
    } catch { /* unreadable metadata: send as-is and let Printify decide */ }
    return { b64, fileName, note: null };
  }

  const m = await sharp(buf).metadata();
  if (!m.width || !m.height) throw new Error(label + ': could not read the SVG dimensions.');

  // librsvg rasterizes at `density` DPI against the SVG's intrinsic size, so scale the
  // density by how far we need to grow rather than rendering small and resizing up.
  const factor = RASTER_LONG_EDGE / Math.max(m.width, m.height);
  const density = Math.max(72, Math.min(100000, Math.round(72 * factor)));
  const png = await sharp(buf, { density })
    .resize({ width: Math.round(m.width * factor), height: Math.round(m.height * factor), fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Live <text> needs the font installed on this server. Printify's own guidance is to
  // convert text to paths, and that matters more now that we do the rasterizing.
  const note = /<text[\s>]/i.test(buf.toString('utf8'))
    ? label + ' contains live SVG text, which renders with whatever fonts this server ' +
      'has, not yours. Convert text to outlines and rebuild if the type looks wrong.'
    : null;

  return {
    b64: png.toString('base64'),
    fileName: String(fileName || 'design.svg').replace(/\.[a-z0-9]+$/i, '') + '.png',
    note,
  };
}

export async function uploadImage(b64, fileName) {
  const res = await fetch(PRINTIFY_BASE + '/uploads/images.json', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.PRINTIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, contents: b64 }),
  });
  if (!res.ok) throw new Error('Image upload failed (' + res.status + '): ' + (await res.text()));
  return (await res.json()).id;
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

function imageObj(id, pl) {
  return { id, x: pl.x, y: pl.y, scale: pl.scale, angle: pl.angle };
}

async function generateDescriptions(voice, designName, vibe) {
  const vibeLine = vibe ? 'Design vibe / notes: ' + vibe + '\n' : '';
  const garmentLines = GARMENT_ORDER.map((k) => '- ' + k + ': ' + GARMENT_DESC[k]).join('\n');
  const userMsg =
    'Design name: "' + designName + '"\n' + vibeLine + '\n' +
    'Write a product description for each of these five garments, tuned to the garment ' +
    '(a heavyweight Comfort Colors reads differently than a cropped boxy tee):\n' + garmentLines + '\n\n' +
    'Rules: lead with the feeling or idea of the design, add one concrete nod to the garment, ' +
    '2 to 3 sentences each, under 320 characters, no emojis, no markdown, no generic ecommerce ' +
    'filler like "premium quality" or "must-have". Return ONLY valid JSON, no code fences, exactly:\n' +
    '{"gildan_tee":"...","comfort_colors_tee":"...","tank":"...","womens_tee":"...","crop":"..."}';

  try {
    const res = await anthropic.messages.create({
      model: DRAFT_MODEL, max_tokens: 1024,
      system: voice + '\n\nYou are writing apparel product descriptions in this brand voice.',
      messages: [{ role: 'user', content: userMsg }],
    });
    const txt = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(txt.replace(/```json/gi, '').replace(/```/g, '').trim());
  } catch {
    return {};
  }
}

function fallbackDesc(designName, key) {
  return '"' + designName + '" on a ' + GARMENT_DESC[key] + '. Edit this line in Printify if you want.';
}

// payload = { shopId, designName, vibe, leftChest, frontB64, frontName, backB64, backName }
export async function buildProducts(payload) {
  const designName = String(payload.designName || '').trim();
  if (!designName) throw new Error('Design name is required.');
  if (!payload.frontB64) throw new Error('A front design is required.');
  if (!process.env.PRINTIFY_TOKEN) throw new Error('PRINTIFY_TOKEN is not set.');

  const shopId = String(payload.shopId || '').trim();
  const store = await getStoreByShopId(shopId);
  if (!store) throw new Error('Pick a valid store (got shop id "' + shopId + '").');

  const config = await getProductConfig(store.brand_key);
  const voice = (await getVoiceRow(store.brand_key)) || fallbackVoice(store.brand_key);
  const warnings = [];
  if (Object.keys(config).length === 0) {
    warnings.push('No pricing/tags configured for ' + store.name + '. Used $' +
      (GENERIC_PRICE_CENTS / 100).toFixed(2) + ' and no tags. Set these in Settings.');
  }

  const frontImg = await prepareImage(payload.frontB64, payload.frontName || 'front.png', 'The front design');
  if (frontImg.note) warnings.push(frontImg.note);
  const frontId = await uploadImage(frontImg.b64, frontImg.fileName);

  let backId = null;
  if (payload.backB64) {
    const backImg = await prepareImage(payload.backB64, payload.backName || 'back.png', 'The back design');
    if (backImg.note) warnings.push(backImg.note);
    backId = await uploadImage(backImg.b64, backImg.fileName);
  }

  const descriptions = await generateDescriptions(voice, designName, payload.vibe);
  const frontPl = payload.leftChest ? PLACEMENT_LEFT_CHEST : PLACEMENT_FULL;

  const results = [];
  for (const key of GARMENT_ORDER) {
    const v = VARIANTS[key];
    const cfg = config[key] || { price_cents: GENERIC_PRICE_CENTS, tags: [] };
    const tags = cfg.tags.slice();
    if (UPSELL_EXEMPT.indexOf(key) === -1 && tags.indexOf(UPSELL_TAG) === -1) tags.push(UPSELL_TAG);

    try {
      const placeholders = [{ position: 'front', images: [imageObj(frontId, frontPl)] }];
      if (backId) placeholders.push({ position: 'back', images: [imageObj(backId, PLACEMENT_FULL)] });

      const body = {
        title: designName + v.title_suffix,
        description: descriptions[key] || fallbackDesc(designName, key),
        blueprint_id: v.blueprint_id,
        print_provider_id: v.print_provider_id,
        tags,
        variants: v.variant_ids.map((id) => ({ id, price: cfg.price_cents, is_enabled: true })),
        print_areas: [{ variant_ids: v.variant_ids, placeholders }],
      };
      const created = await createProduct(shopId, body);
      results.push({ label: v.label, ok: true, productId: created.id, title: body.title });
    } catch (err) {
      results.push({ label: v.label, ok: false, error: String(err.message || err) });
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  return { storeName: store.name, designName, hadBack: !!backId, warnings, results };
}
