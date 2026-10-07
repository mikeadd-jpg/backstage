// GET /api/briefing          -> today's written briefing (cached per area set per day)
// GET /api/briefing?force=1  -> write it again from fresh data, at most every 15 minutes
//
// Claude reads a digest of the business filtered to this person's areas (lib/briefing.js)
// and returns the good, the bad and what to do. { briefing: null } for roles with no
// Insights areas, whose Home is the live items only.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { briefingFor } from '../../../lib/briefing.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req) {
  const gate = await requireArea(req, 'home');
  if (gate.error) return gate.error;
  try {
    const briefing = await briefingFor(gate.access.areas, { force: !!req.nextUrl.searchParams.get('force') });
    return NextResponse.json({ briefing }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
