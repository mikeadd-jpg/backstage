// New products into the market catalogs their tags name (lib/marketPublish.js).
//   GET  ?brand=                         what would be published (nothing changes)
//   POST { brand, productIds? }          publish them; the server re-checks first
// Area `products`, the builder's own. Not exposed over MCP.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { configuredShopifyBrands } from '../../../lib/brands.js';
import { previewMarketPublish, publishToMarkets } from '../../../lib/marketPublish.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const check = (b) => { if (!configuredShopifyBrands().includes(b)) throw new Error('Unknown store.'); return b; };

export async function GET(req) {
  const gate = await requireArea(req, 'products');
  if (gate.error) return gate.error;
  try { return NextResponse.json(await previewMarketPublish(check(new URL(req.url).searchParams.get('brand')))); }
  catch (err) { return NextResponse.json({ error: String(err.message || err) }, { status: 400 }); }
}

export async function POST(req) {
  const gate = await requireArea(req, 'products');
  if (gate.error) return gate.error;
  try {
    const b = await req.json();
    const ids = Array.isArray(b.productIds) ? b.productIds.map(String) : null;
    return NextResponse.json(await publishToMarkets(check(b.brand), ids));
  } catch (err) { return NextResponse.json({ error: String(err.message || err) }, { status: 400 }); }
}
