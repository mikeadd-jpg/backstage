// Runs the email pipeline once.
//   Manual:      POST /api/ingest  with header  x-ingest-key: <INGEST_SECRET>
//   Vercel Cron: GET  /api/ingest
//
// Cron auth: Vercel only sends "Authorization: Bearer <CRON_SECRET>" if you have created
// a CRON_SECRET environment variable. It also stamps its own x-vercel-cron header on
// scheduled invocations, and strips that header from outside requests, so we accept
// either. Without both, a missing CRON_SECRET would silently 401 every scheduled run.
import { NextResponse } from 'next/server';
import { runIngest } from '../../../lib/pipeline.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true; // Vercel-internal, cannot be spoofed externally
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === 'Bearer ' + secret) return true;
  return false;
}

async function run() {
  try {
    return NextResponse.json(await runIngest());
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
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
