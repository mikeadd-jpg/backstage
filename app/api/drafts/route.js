// Drafts: mockups (area mockups) and video and image ads (area ads), kept until deleted.
//
//   GET  ?brand=&kind=&status=   the drafts this person's areas cover, newest first
//   GET  ?id=                    one draft, with its plan and assets (to reopen in a builder)
//   POST { action: 'save', id?, brand, kind, title?, plan?, assets?, output?, source? }
//        creates or updates; every file it names must already be in our Blob store
//   POST { action: 'status', id, status }   draft | favorite
//   POST { action: 'delete', id }            removes the draft and the files only it used
//
// Not exposed over MCP yet (phase 4 adds a creative connection of its own).
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { configuredShopifyBrands } from '../../../lib/brands.js';
import { listDrafts, getDraft, saveDraft, setDraftStatus, deleteDraft } from '../../../lib/drafts.js';

export const dynamic = 'force-dynamic';

// Which kinds a person may see and change, from their areas.
const kindsFor = (areas) => [
  ...(areas.includes('mockups') ? ['mockup'] : []),
  ...(areas.includes('ads') ? ['video', 'image'] : []),
];
const inStore = (u) => /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(String(u || ''));

export async function GET(req) {
  const gate = await requireArea(req, ['mockups', 'ads']);
  if (gate.error) return gate.error;
  const kinds = kindsFor(gate.access.areas);
  const q = new URL(req.url).searchParams;
  try {
    if (q.get('id')) {
      const d = await getDraft(q.get('id'));
      if (!d || !kinds.includes(d.kind)) return NextResponse.json({ error: 'That draft is gone.' }, { status: 404 });
      return NextResponse.json({ draft: d });
    }
    const kind = q.get('kind');
    const drafts = await listDrafts({
      kinds: kind && kinds.includes(kind) ? [kind] : kinds,
      brand: q.get('brand') || null,
      status: q.get('status') || null,
    });
    return NextResponse.json({ drafts, kinds, brands: configuredShopifyBrands() }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, ['mockups', 'ads']);
  if (gate.error) return gate.error;
  const kinds = kindsFor(gate.access.areas);
  try {
    const b = await req.json();
    const existing = b.id ? await getDraft(b.id) : null;
    if (b.id && !existing) throw new Error('That draft is gone.');
    const kind = existing ? existing.kind : b.kind;
    if (!kinds.includes(kind)) throw new Error("Your role doesn't include that kind of draft.");

    if (b.action === 'status') { await setDraftStatus(b.id, b.status); return NextResponse.json({ ok: true }); }
    if (b.action === 'delete') { await deleteDraft(b.id); return NextResponse.json({ ok: true }); }
    if (b.action !== 'save') throw new Error('Unknown action.');

    const brand = existing ? existing.brand : b.brand;
    if (!configuredShopifyBrands().includes(brand)) throw new Error('Unknown store.');
    // Only our own stored files: a draft can never point at an arbitrary URL.
    for (const a of b.assets || []) if (a.url && !inStore(a.url)) throw new Error('A picture in this draft is not stored yet.');
    if (b.output && (!inStore(b.output.url) || (b.output.poster && !inStore(b.output.poster)))) throw new Error('The rendered file is not stored yet.');
    const draft = await saveDraft({
      id: existing ? existing.id : null, brand, kind,
      title: b.title, plan: b.plan, assets: b.assets, output: b.output, source: b.source, by: gate.access.email,
    });
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
