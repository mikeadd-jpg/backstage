// The product builder, adults and kids (`group`), in two steps so no request grows with
// the number of products:
//   GET  /api/builder?group=adults|kids   every product, its Global Fulfillment listing or
//                                         its markets, with printers ranked per market.
//   POST { action: 'prepare', group, ... } uploads the design once, writes descriptions.
//   POST { action: 'upload', b64, name, label } uploads one extra design (a per-colour
//                                         one), one per request to stay under the body limit.
//   POST { action: 'build', group, key, listings } creates one product's listings.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { prepareAdults, prepareImage, uploadImage, PLACEMENT_FULL, PLACEMENT_LEFT_CHEST } from '../../../lib/builder.js';
import { prepareKids } from '../../../lib/kids.js';
import { builderCatalog, buildProduct } from '../../../lib/printers.js';

export const dynamic = 'force-dynamic';
// A cold catalog load reads every printer of every blueprint from Printify (cached 12h after).
export const maxDuration = 300;

function groupOf(v) {
  if (v !== 'adults' && v !== 'kids') throw new Error('group must be adults or kids');
  return v;
}

export async function GET(req) {
  const gate = await requireArea(req, 'products');
  if (gate.error) return gate.error;
  try {
    const group = groupOf(new URL(req.url).searchParams.get('group') || 'adults');
    return NextResponse.json(await builderCatalog(group));
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'products');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();
    const group = groupOf(body.group);
    if (body.action === 'prepare') {
      return NextResponse.json(group === 'kids' ? await prepareKids(body) : await prepareAdults(body));
    }
    if (body.action === 'upload') {
      if (!body.b64) throw new Error('No image sent.');
      const img = await prepareImage(body.b64, body.name || 'design.png', String(body.label || 'A design'));
      return NextResponse.json({ id: await uploadImage(img.b64, img.fileName), note: img.note });
    }
    if (body.action === 'build') {
      return NextResponse.json(await buildProduct({
        group, shopId: body.shopId, key: body.key, designName: body.designName,
        description: body.description, frontId: body.frontId, backId: body.backId || null,
        placement: body.leftChest ? PLACEMENT_LEFT_CHEST : PLACEMENT_FULL,
        colorDesigns: body.colorDesigns || {},
        listings: body.listings,
      }));
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
