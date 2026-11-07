// A video rendered in the browser by the Ads tab's video builder, sent to the brand's Meta
// ad account a piece at a time. Nothing is stored here: each request carries one piece
// of the file straight through to Meta's chunked upload (see lib/meta.js).
//
//   POST ?brand=&phase=start&size=N              { sessionId, videoId, start, end }
//   POST ?brand=&phase=transfer&session=&start=  body: raw bytes from `start`, at most
//                                                MAX_CHUNK. Returns { start, end } next.
//   POST ?brand=&phase=finish&session=&name=     { videoId }
//
// Processing is then polled with { action: 'video-status' } on /api/ads, exactly as for a
// Canva video, and the creative is built with { action: 'build-video' }.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { creativeBrands } from '../../../../lib/brands.js';
import { metaAccountFor, startAdVideoUpload, transferAdVideoChunk, finishAdVideoUpload } from '../../../../lib/meta.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Vercel refuses request bodies over 4.5MB, so pieces stay under 4MB.
// The tab slices at the same size (CHUNK_BYTES in lib/adPlans.js).
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_FILE = 1024 * 1024 * 1024;     // Meta takes up to 4GB; an ad from here is far smaller

export async function POST(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  try {
    const q = new URL(req.url).searchParams;
    const brand = q.get('brand') || '';
    if (!creativeBrands().includes(brand) || !metaAccountFor(brand)) {
      throw new Error('No ad account is configured for ' + brand + '.');
    }
    const phase = q.get('phase');
    const session = q.get('session') || '';
    if (phase !== 'start' && !/^\d+$/.test(session)) throw new Error('No upload session.');

    if (phase === 'start') {
      const size = Number(q.get('size'));
      if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) throw new Error('That video is empty or too large.');
      return NextResponse.json(await startAdVideoUpload(brand, size));
    }
    if (phase === 'transfer') {
      const start = Number(q.get('start'));
      if (!Number.isInteger(start) || start < 0) throw new Error('Bad offset.');
      const chunk = new Uint8Array(await req.arrayBuffer());
      if (!chunk.length || chunk.length > MAX_CHUNK) throw new Error('A piece must be between 1 byte and 4MB.');
      return NextResponse.json(await transferAdVideoChunk(brand, { sessionId: session, start, chunk }));
    }
    if (phase === 'finish') {
      const slug = String(q.get('name') || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';
      await finishAdVideoUpload(brand, { sessionId: session, name: brand + '-builder-' + slug + '.mp4' });
      return NextResponse.json({ ok: true });
    }
    throw new Error('Unknown phase.');
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
