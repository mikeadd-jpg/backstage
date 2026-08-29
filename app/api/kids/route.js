// POST /api/kids -> the kids product builder, in two steps so each request fits inside
// the 60 second function limit on Vercel's Hobby plan.
//
//   { action: 'prepare', ... }  uploads the design once and writes the descriptions.
//   { action: 'build', ... }    creates every region of ONE garment group.
//
// The client calls prepare once, then build once per group, showing progress as it goes.
import { NextResponse } from 'next/server';
import { prepareImage, uploadImage, PLACEMENT_FULL, PLACEMENT_LEFT_CHEST } from '../../../lib/builder.js';
import {
  KIDS_CATALOG, buildKidsGroup, generateKidsDescriptions, kidsFallbackDesc, kidsVoice,
} from '../../../lib/kids.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function prepare(body) {
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

  return {
    storeName: store.name,
    frontId,
    backId,
    descriptions,
    warnings,
    groups: KIDS_CATALOG.map((g) => ({
      key: g.key,
      label: g.label,
      regions: g.regions.map((r) => r.region),
    })),
  };
}

// GET /api/kids -> the catalog, so the builder can render its checkbox list before
// anything is uploaded.
export async function GET() {
  return NextResponse.json({
    groups: KIDS_CATALOG.map((g) => ({
      key: g.key,
      label: g.label,
      blurb: g.blurb,
      regions: g.regions.map((r) => r.region),
    })),
  });
}

export async function POST(req) {
  try {
    const body = await req.json();

    if (body.action === 'prepare') {
      return NextResponse.json(await prepare(body));
    }

    if (body.action === 'build') {
      const result = await buildKidsGroup({
        shopId: body.shopId,
        groupKey: body.groupKey,
        designName: String(body.designName || '').trim(),
        description: body.description,
        frontId: body.frontId,
        backId: body.backId || null,
        placement: body.leftChest ? PLACEMENT_LEFT_CHEST : PLACEMENT_FULL,
        regions: body.regions,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
