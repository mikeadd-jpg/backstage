// POST /api/mockups -> lifestyle product images, split into steps so no single request
// has to carry a whole batch. The split is for progress and blast radius, not for a time
// limit: this account is on Pro, where functions get 300s by default and up to 800s.
//
//   { action: 'list', brand }                   active products for one store
//   { action: 'generate', brand, imageUrl, ... } exactly one image, returned as base64
//
// A batch of five is five 'generate' calls from the client, not one call that loops.
// Same reason the kids builder is split: one slow or failed image cannot take the rest
// with it, results appear as they land, and no single request grows toward the limit.
// The client sends variationIndex; the variation text itself is resolved here so the
// list stays in one place and the response can echo back what was actually used.
//   { action: 'attach', brand, productId, b64, main } push an approved image onto the
//                                                product; main moves it to the front
//   { action: 'make-main', brand, productId, mediaId } front an image already attached
//   { action: 'suggest-scene', brand, product, current, previous } Claude writes a new scene
//   { action: 'attach-meta', brand, b64 }        push it into the Meta ad image library
//   { action: 'save-scene', brand, scene }       store that brand's scene direction
//
// "Send everywhere" is the client calling attach and attach-meta in turn rather than a
// combined action, so a half-success reports which half, and each destination keeps its
// own error.
//
// Generated images are never persisted. They live in the browser between generate and
// attach, which keeps a review step in the loop and avoids needing a blob store.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, addProductImage, setProductMainImage } from '../../../lib/shopify.js';
import {
  generateMockup, sceneFor, defaultScene, saveScene, suggestScene, variationsFor, SIZES,
} from '../../../lib/mockups.js';
import { uploadAdImage, metaAccountFor } from '../../../lib/meta.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// How many shots one batch may ask for. Not a technical ceiling, since each image is its
// own request: it is a spending guard, because the button spends real money per image.
const MAX_BATCH = 6;

function checkBrand(brand) {
  if (!brand || !configuredShopifyBrands().includes(brand)) {
    throw new Error('Unknown or unconfigured brand: ' + brand);
  }
  return brand;
}

// GET /api/mockups -> which stores can be used, and their current scene direction, so
// the tab can render before anything is picked.
export async function GET(req) {
  const gate = await requireArea(req, 'mockups');
  if (gate.error) return gate.error;
  const brands = configuredShopifyBrands();
  const scenes = {};
  const defaults = {};
  const variations = {};
  const meta = {};
  for (const b of brands) {
    scenes[b] = await sceneFor(b);
    defaults[b] = defaultScene(b);
    variations[b] = variationsFor(b, MAX_BATCH);
    // Surfaced so the tab can show which advertiser it is about to push into. The
    // account names in this business do not match the brand keys, so "configured" on
    // its own would not tell you whether it is configured *correctly*.
    //
    // Reported independently of the token on purpose. Gating this on META_ACCESS_TOKEN
    // made a missing token look like a missing ad account, which sends you to fix the
    // wrong thing. Two facts, two fields.
    meta[b] = metaAccountFor(b);
  }
  return NextResponse.json({
    brands: brands.map((b) => ({ key: b, name: BRANDS[b].name })),
    scenes,
    defaults,
    variations,
    maxBatch: MAX_BATCH,
    meta,
    metaToken: Boolean(process.env.META_ACCESS_TOKEN),
    sizes: Object.keys(SIZES),
    ready: Boolean(process.env.OPENAI_API_KEY),
  });
}

export async function POST(req) {
  const gate = await requireArea(req, 'mockups');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();

    if (body.action === 'list') {
      const brand = checkBrand(body.brand);
      return NextResponse.json({ products: await listActiveProducts(brand) });
    }

    if (body.action === 'generate') {
      const brand = checkBrand(body.brand);
      const idx = Number(body.variationIndex);
      const variation = Number.isInteger(idx) && idx >= 0
        ? variationsFor(brand, idx + 1)[idx]
        : null;
      const result = await generateMockup({
        brand,
        imageUrl: body.imageUrl,
        scene: body.scene,
        notes: body.notes,
        size: body.size,
        quality: body.quality,
        variation,
      });
      return NextResponse.json(result);
    }

    if (body.action === 'attach') {
      const brand = checkBrand(body.brand);
      if (!body.productId) throw new Error('No product to attach to.');
      if (!body.b64) throw new Error('No image to attach.');
      const media = await addProductImage(brand, body.productId, body.b64, body.alt, { main: Boolean(body.main) });
      return NextResponse.json(media);
    }

    // For a shot that is already on the product as a secondary image: move it rather
    // than upload it a second time.
    if (body.action === 'make-main') {
      const brand = checkBrand(body.brand);
      if (!body.productId || !body.mediaId) throw new Error('No product image to move.');
      await setProductMainImage(brand, body.productId, body.mediaId);
      return NextResponse.json({ id: body.mediaId, main: true });
    }

    if (body.action === 'suggest-scene') {
      const brand = checkBrand(body.brand);
      const p = body.product || {};
      const scene = await suggestScene({
        brand,
        // Only the fields the prompt uses, so the client cannot steer it with anything else.
        product: { title: p.title, productType: p.productType, image: p.image },
        current: body.current,
        previous: Array.isArray(body.previous) ? body.previous : [],
      });
      return NextResponse.json({ scene });
    }

    if (body.action === 'attach-meta') {
      const brand = checkBrand(body.brand);
      if (!body.b64) throw new Error('No image to send.');
      // Brand-prefixed here rather than client side, so it holds however it is called.
      // Two brands can share one ad account, and in a shared library the product handle
      // alone does not say which store an asset came from.
      const name = brand + '-' + (body.name || 'lifestyle.png');
      const image = await uploadAdImage(brand, body.b64, name);
      return NextResponse.json(image);
    }

    if (body.action === 'save-scene') {
      const brand = checkBrand(body.brand);
      await saveScene(brand, body.scene);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
