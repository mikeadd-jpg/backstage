// The worker behind Inspiration batches (lib/recreate.js). A batch is handed from one
// invocation to the next through here, so no single function has to last the whole batch.
// Exempt from the sign-in gate (middleware.js); it checks INGEST_SECRET in x-worker-key,
// and only ever works on a batch someone already started.
import { NextResponse, after } from 'next/server';
import { driveBatch } from '../../../../lib/recreate.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function POST(req) {
  if (!process.env.INGEST_SECRET || req.headers.get('x-worker-key') !== process.env.INGEST_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await req.json().catch(() => ({}));
  if (!(Number(id) > 0)) return NextResponse.json({ error: 'which batch?' }, { status: 400 });
  after(() => driveBatch(Number(id)).catch((err) => console.error('[recreate] worker ' + id, err)));
  return NextResponse.json({ ok: true }, { status: 202 });
}
