// POST /api/resolve { id, action } -> action 'reopen' moves it back to the open queue,
// anything else marks it resolved (leaves the queue, kept in history).
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { resolveInquiry, reopenInquiry } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const gate = await requireArea(req, 'inbox');
  if (gate.error) return gate.error;
  try {
    const { id, action } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    if (action === 'reopen') await reopenInquiry(id);
    else await resolveInquiry(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
