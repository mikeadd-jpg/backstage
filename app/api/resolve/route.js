// POST /api/resolve { id } -> marks an inquiry resolved so it leaves the open queue.
import { NextResponse } from 'next/server';
import { resolveInquiry } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await resolveInquiry(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
