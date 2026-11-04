// Recreate competitor ads in bulk (lib/recreate.js): our own mockups, ad and render for
// each picked ad, all kept in Drafts.
//
//   GET                       the latest batches with each ad's progress; wakes any whose
//                             worker went quiet
//   POST { action: 'start', brand, picks: [{ type: 'ad'|'capture', id }], make, perAd,
//          aspect, notes }    starts a batch (at most 20 mockups) and works on it after
//                             answering
//   POST { action: 'brief', brand, brief, count, make, perAd, aspect }  the same from our
//                             own idea: Claude writes `count` angles, each made into an ad
//   POST { action: 'stop', id }   stops a batch; what it already made stays in Drafts
//
// Needs the inspiration, mockups and ads areas: it spends on images and makes ad drafts.
// Not exposed over MCP yet (phase 4).
import { NextResponse, after } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { batchSpend, monthSpend } from '../../../lib/spend.js';
import { configuredShopifyBrands, BRANDS } from '../../../lib/brands.js';
import { createBatch, createBriefBatch, createApprovedBrief, fillBrief, listBriefTemplates, saveBriefTemplate, deleteBriefTemplate, stopBatch, listBatches, driveBatch, wakeIdleBatches, MAX_MOCKUPS, MAX_ITEMS, MAX_PER_AD, MAX_BRIEF_SHOTS } from '../../../lib/recreate.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

async function gate(req) {
  const g = await requireArea(req, 'inspiration');
  if (g.error) return g;
  if (!['mockups', 'ads'].every((a) => g.access.areas.includes(a))) {
    return { error: NextResponse.json({ error: 'Recreating ads needs the Mockups and Ads screens too.' }, { status: 403 }) };
  }
  return g;
}

export async function GET(req) {
  const g = await gate(req);
  if (g.error) return g.error;
  try {
    const list = await listBatches();
    const [spend, month] = await Promise.all([batchSpend(list.map((b) => b.id)).catch(() => ({})), monthSpend().catch(() => null)]);
    const batches = list.map((b) => ({ ...b, spend: spend[b.id] || { cost: 0, images: 0 } }));
    if (batches.some((b) => b.status === 'running')) after(() => wakeIdleBatches().catch((err) => console.error('[recreate] wake', err)));
    return NextResponse.json({ batches, month, brands: configuredShopifyBrands().map((k) => ({ key: k, name: BRANDS[k].name })), limits: { mockups: MAX_MOCKUPS, items: MAX_ITEMS, perAd: MAX_PER_AD } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const g = await gate(req);
  if (g.error) return g.error;
  try {
    const b = await req.json();
    if (b.action === 'start') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      const batch = await createBatch({
        brand: b.brand, picks: b.picks, make: b.make, perAd: b.perAd, aspect: b.aspect, notes: b.notes, recipe: b.recipe || null,
        by: g.access.email, origin: new URL(req.url).origin,
      });
      after(() => driveBatch(batch.id).catch((err) => console.error('[recreate] batch ' + batch.id, err)));
      return NextResponse.json({ batch });
    }
    if (b.action === 'brief') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      const batch = await createBriefBatch({
        brand: b.brand, brief: b.brief, count: b.count, make: b.make, perAd: b.perAd, aspect: b.aspect,
        by: g.access.email, origin: new URL(req.url).origin,
      });
      after(() => driveBatch(batch.id).catch((err) => console.error('[recreate] batch ' + batch.id, err)));
      return NextResponse.json({ batch });
    }
    // A brief the person approved in the editor: their products, pictures and words.
    if (b.action === 'approve') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      const batch = await createApprovedBrief({
        brand: b.brand, brief: b.brief, products: b.products, pickCount: b.pickCount, source: b.source || null,
        by: g.access.email, origin: new URL(req.url).origin,
      });
      after(() => driveBatch(batch.id).catch((err) => console.error('[recreate] batch ' + batch.id, err)));
      return NextResponse.json({ batch, maxShots: MAX_BRIEF_SHOTS });
    }
    if (b.action === 'fill-brief') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      return NextResponse.json({ brief: await fillBrief({ brand: b.brand, idea: b.idea }) });
    }
    if (b.action === 'templates') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      return NextResponse.json({ templates: await listBriefTemplates(b.brand) });
    }
    if (b.action === 'save-template') {
      if (!configuredShopifyBrands().includes(b.brand)) throw new Error('Pick one of our stores.');
      return NextResponse.json({ template: await saveBriefTemplate({ brand: b.brand, name: b.name, brief: b.brief, by: g.access.email }) });
    }
    if (b.action === 'delete-template') { await deleteBriefTemplate(b.id); return NextResponse.json({ ok: true }); }
    if (b.action === 'stop') { await stopBatch(b.id); return NextResponse.json({ ok: true }); }
    throw new Error('Unknown action.');
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
