// Fetches competitors' Meta ads into Inspiration (lib/adLibrary.js), daily by Vercel Cron.
//   Vercel Cron: GET  with x-vercel-cron or Authorization: Bearer $CRON_SECRET
//   Manual:      POST with x-ingest-key: $INGEST_SECRET
// Exempt from the sign-in gate like the other crons. Refresh in the tab runs the same
// function through /api/inspiration.
import { NextResponse } from 'next/server';
import { refreshCompetitorAds } from '../../../lib/adLibrary.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true;
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && req.headers.get('authorization') === 'Bearer ' + secret);
}

async function run() {
  try { return NextResponse.json(await refreshCompetitorAds({ budgetMs: 270000 })); }
  catch (err) { return NextResponse.json({ error: String(err.message || err) }, { status: 500 }); }
}

export async function POST(req) {
  if (req.headers.get('x-ingest-key') !== process.env.INGEST_SECRET) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return run();
}
export async function GET(req) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return run();
}
