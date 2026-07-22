// Runs the proactive order risk scan.
//   Manual:      POST /api/scan  with header  x-ingest-key: <INGEST_SECRET>
//   Vercel Cron: GET  /api/scan   (see the cron auth note in /api/ingest)
import { NextResponse } from 'next/server';
import { runScan } from '../../../lib/risk.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true;
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === 'Bearer ' + secret) return true;
  return false;
}

async function run() {
  try { return NextResponse.json(await runScan()); }
  catch (err) { return NextResponse.json({ error: String(err.message || err) }, { status: 500 }); }
}

export async function POST(req) {
  if (req.headers.get('x-ingest-key') !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return run();
}
export async function GET(req) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return run();
}
