// POST /api/mockups -> lifestyle product images, split into steps so that no single
// request comes near the 60 second function limit on Vercel's Hobby plan.
//
//   { action: 'list', brand }                   active products for one store
//   { action: 'generate', brand, imageUrl, ... } exactly one image, returned as base64
//   { action: 'attach', brand, productId, b64 }  push an approved image onto the product
//   { action: 'save-scene', brand, scene }       store that brand's scene direction
//
// Generated images are never persisted. They live in the browser between generate and
// attach, which keeps a review step in the loop and avoids needing a blob store.
import { NextResponse } from 'next/server';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, addProductImage } from '../../../lib/shopify.js';
import { generateMockup, sceneFor, defaultScene, saveScene, SIZES } from '../../../lib/mockups.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  for (const b of brands) {
    scenes[b] = await sceneFor(b);
    defaults[b] = defaultScene(b);
  }
  return NextResponse.json({
    brands: brands.map((b) => ({ key: b, name: BRANDS[b].name })),
    scenes,
    defaults,
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
