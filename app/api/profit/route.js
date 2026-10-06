// GET /api/profit?brand=all|<brand name> -> period summaries and a daily series from the
// Profit Combined sheet. Restricted by canViewProfit(), re-checked on every call against
// the signed session rather than trusted from the client. Not exposed over MCP: that
// connection does not know which person is on the other end.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from '../../../lib/session.js';
import { canViewProfit, readProfitRows, summarize } from '../../../lib/profit.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // 404 rather than 403, so the endpoint does not advertise that it exists.
  if (!canViewProfit(session.email)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const brand = new URL(req.url).searchParams.get('brand') || 'all';
    return NextResponse.json(summarize(await readProfitRows(), brand), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
