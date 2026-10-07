// GET /api/profit -> the daily P&L rows from the Profit Combined sheet, for the tab to
// slice by brand and date on the device (lib/profitMath.js). Restricted to roles with the
// profit area (lib/roles.js; today only owners), read fresh from the database on every
// call. Answers 404 to everyone else so the route does not admit it exists. Not exposed
// over MCP: that connection does not know which person is on the other end.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { readProfitRows, profitPayload } from '../../../lib/profit.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req) {
  // Both Insights tabs read these rows (Profit and Attribution).
  const gate = await requireArea(req, ['profit', 'attribution'], { hide: true });
  if (gate.error) return gate.error;
  try {
    return NextResponse.json(profitPayload(await readProfitRows()), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
