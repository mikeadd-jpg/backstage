// GET /api/focus?part=ops       -> live items: customers waiting, risky orders, approvals
// GET /api/focus?part=insights  -> profit, ads, email and traffic items for the last 7 days
//
// Scored and explained in lib/focus.js. Each part only reads the areas this person's role
// includes, so Home shows nobody a number their role would hide.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { focusPart } from '../../../lib/focus.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 180;

export async function GET(req) {
  const gate = await requireArea(req, 'home');
  if (gate.error) return gate.error;
  const part = req.nextUrl.searchParams.get('part') === 'insights' ? 'insights' : 'ops';
  try {
    return NextResponse.json(await focusPart(part, gate.access.areas), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
