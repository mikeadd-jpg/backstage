// GET /api/traffic                         -> brands and today, for the shared Insights filters
// GET /api/traffic?from=YYYY-MM-DD&to=...  -> each brand's sessions, funnel, channels, landing
//                                             pages, devices and daily series for that range
// GET /api/traffic?from=...&to=...&lite=1  -> channels and totals only, for the comparison period
//
// From Shopify Analytics through lib/traffic.js. Owner-only through the traffic area
// (lib/roles.js), and 404 to everyone else.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { trafficFor, trafficBrands, todayLocal } from '../../../lib/traffic.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req) {
  const gate = await requireArea(req, 'traffic', { hide: true });
  if (gate.error) return gate.error;
  const q = req.nextUrl.searchParams;
  const from = q.get('from'), to = q.get('to');
  try {
    if (!from && !to) return json({ today: todayLocal(), brands: trafficBrands(), rows: [] });
    if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json({ error: 'from and to must be dates, from first' }, 400);
    return json({ from, to, brands: await trafficFor(from, to, { lite: !!q.get('lite') }) });
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }
}
