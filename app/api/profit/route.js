// GET /api/profit -> the daily P&L rows from the Profit Combined sheet, for the tab to
// slice by brand and date on the device (lib/profitMath.js). Restricted by
// canViewProfit(), re-checked on every call against the signed session rather than
// trusted from the client. Not exposed over MCP: that
// connection does not know which person is on the other end.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from '../../../lib/session.js';
import { canViewProfit, readProfitRows, profitPayload } from '../../../lib/profit.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // 404 rather than 403, so the endpoint does not advertise that it exists.
  if (!canViewProfit(session.email)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    return NextResponse.json(profitPayload(await readProfitRows()), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
