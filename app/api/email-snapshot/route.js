// Daily cron: records each brand's Klaviyo subscriber count in email_list_snapshots.
// Klaviyo keeps no history of that number, so this table is the only place the total over
// time exists. The Email tab also records a count whenever it loads; this makes sure a day
// with nobody looking still gets one.
//   Vercel Cron: GET /api/email-snapshot (same auth as /api/scan)
//   Manual:      POST with header x-ingest-key: <INGEST_SECRET>
import { NextResponse } from 'next/server';
import { snapshotAll } from '../../../lib/klaviyo.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true;
  const secret = process.env.CRON_SECRET;
  return !!(secret && req.headers.get('authorization') === 'Bearer ' + secret);
}

async function run() {
  try { return NextResponse.json({ brands: await snapshotAll() }); }
  catch (err) { return NextResponse.json({ error: String(err.message || err) }, { status: 500 }); }
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
