// Runs the pipeline once.
//   Manual/local:  POST /api/ingest  with header  x-ingest-key: <INGEST_SECRET>
//   Vercel Cron:   GET  /api/ingest  (Vercel sends  Authorization: Bearer <CRON_SECRET>)
import { NextResponse } from 'next/server';
import { runIngest } from '../../../lib/pipeline.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  if (req.headers.get('authorization') !== 'Bearer ' + process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return run();
}
