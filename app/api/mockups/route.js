// POST /api/mockups -> lifestyle product images, split into steps so no single request
// has to carry a whole batch. The split is for progress and blast radius, not for a time
// limit: this account is on Pro, where functions get 300s by default and up to 800s.
//
//   { action: 'list', brand }                   active products for one store
//   { action: 'generate', brand, imageUrl, ... } exactly one image, returned as base64
//   { action: 'attach', brand, productId, b64 }  push an approved image onto the product
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
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, addProductImage } from '../../../lib/shopify.js';
import { generateMockup, sceneFor, defaultScene, saveScene, SIZES } from '../../../lib/mockups.js';
import { uploadAdImage, metaAccountFor } from '../../../lib/meta.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function checkBrand(brand) {
  if (!brand || !configuredShopifyBrands().includes(brand)) {
    throw new Error('Unknown or unconfigured brand: ' + brand);
  }
  return brand;
}

// GET /api/mockups -> which stores can be used, and their current scene direction, so
// the tab can render before anything is picked.
export async function GET() {
  const brands = configuredShopifyBrands();
  const scenes = {};
  const defaults = {};
  const meta = {};
  for (const b of brands) {
    scenes[b] = await sceneFor(b);
    defaults[b] = defaultScene(b);
    // Surfaced so the tab can show which advertiser it is about to push into. The
    // account names in this business do not match the brand keys, so "configured" on
    // its own would not tell you whether it is configured *correctly*.
    meta[b] = process.env.META_ACCESS_TOKEN ? metaAccountFor(b) : null;
  }
  return NextResponse.json({
    brands: brands.map((b) => ({ key: b, name: BRANDS[b].name })),
    scenes,
    defaults,
    meta,
    sizes: Object.keys(SIZES),
    ready: Boolean(process.env.OPENAI_API_KEY),
  });
}

export async function POST(req) {
  try {
    const body = await req.json();

    if (body.action === 'list') {
      const brand = checkBrand(body.brand);
      return NextResponse.json({ products: await listActiveProducts(brand) });
    }

    if (body.action === 'generate') {
      const brand = checkBrand(body.brand);
      const result = await generateMockup({
        brand,
        imageUrl: body.imageUrl,
        scene: body.scene,
        notes: body.notes,
        size: body.size,
        quality: body.quality,
      });
      return NextResponse.json(result);
    }

    if (body.action === 'attach') {
      const brand = checkBrand(body.brand);
      if (!body.productId) throw new Error('No product to attach to.');
      if (!body.b64) throw new Error('No image to attach.');
      const media = await addProductImage(brand, body.productId, body.b64, body.alt);
      return NextResponse.json(media);
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
