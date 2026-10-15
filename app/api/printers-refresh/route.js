// Weekly cron: re-reads every printer's price, rating, shipping and colours from Printify
// and saves the builder's catalog (lib/printers.js), so the Products tab opens instantly
// from that copy instead of asking Printify each time.
//   Vercel Cron: GET /api/printers-refresh (same auth as /api/scan)
//   Manual:      POST with header x-ingest-key: <INGEST_SECRET>
import { NextResponse } from 'next/server';
import { refreshCatalog } from '../../../lib/printers.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true;
  const secret = process.env.CRON_SECRET;
  return !!(secret && req.headers.get('authorization') === 'Bearer ' + secret);
}

async function run() {
  const out = {};
  for (const group of ['adults', 'kids']) {
    try {
      const d = await refreshCatalog(group, true);
      out[group] = { products: d.products.length, incomplete: d.products.filter((p) => p.partial || p.error || p.globalMissing).map((p) => p.key) };
    } catch (err) {
      out[group] = { error: String(err.message || err) };
    }
  }
  return NextResponse.json(out);
}

export async function GET(req) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return run();
}
export async function POST(req) {
  if (req.headers.get('x-ingest-key') !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return run();
}
