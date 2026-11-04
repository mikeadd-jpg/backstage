// Runs the email pipeline once.
//   Manual:      POST /api/ingest  with header  x-ingest-key: <INGEST_SECRET>
//   Vercel Cron: GET  /api/ingest
//
// Cron auth: Vercel only sends "Authorization: Bearer <CRON_SECRET>" if you have created
// a CRON_SECRET environment variable. It also stamps its own x-vercel-cron header on
// scheduled invocations, and strips that header from outside requests, so we accept
// either. Without both, a missing CRON_SECRET would silently 401 every scheduled run.
import { NextResponse, after } from 'next/server';
import { runIngest } from '../../../lib/pipeline.js';
import { settleRenders } from '../../../lib/serverRender.js';
import { wakeIdleBatches } from '../../../lib/recreate.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function cronAuthorized(req) {
  if (req.headers.get('x-vercel-cron')) return true; // Vercel-internal, cannot be spoofed externally
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === 'Bearer ' + secret) return true;
  return false;
}

async function run() {
  // Server renders whose page was closed are settled here too (lib/serverRender.js), after
  // the response, so a render started from a phone lands in Drafts even if nobody looks.
  // This rides the ingest cron rather than a cron of its own so Neon can still sleep.
  after(() => settleRenders().catch((err) => console.error('settleRenders', err)));
  // Inspiration batches whose worker went quiet are restarted here too (lib/recreate.js).
  after(() => wakeIdleBatches().catch((err) => console.error('wakeIdleBatches', err)));
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
