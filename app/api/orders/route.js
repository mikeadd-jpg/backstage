// GET /api/orders                         -> brands and today, for the shared Insights filters
// GET /api/orders?from=YYYY-MM-DD&to=...  -> each brand's newest 50 orders in that range, with
//                                            UTMs, Shopify's visit source and the sales channel
//
// From Shopify through lib/orders.js. Owner-only through the orders area (lib/roles.js),
// and 404 to everyone else.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { recentOrdersFor, orderBrands, ORDER_LIMIT } from '../../../lib/orders.js';
import { todayLocal } from '../../../lib/traffic.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req) {
  const gate = await requireArea(req, 'orders', { hide: true });
  if (gate.error) return gate.error;
  const q = req.nextUrl.searchParams;
  const from = q.get('from'), to = q.get('to');
  try {
    if (!from && !to) return json({ today: todayLocal(), brands: orderBrands(), rows: [] });
    if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json({ error: 'from and to must be dates, from first' }, 400);
    return json({ from, to, limit: ORDER_LIMIT, brands: await recentOrdersFor(from, to) });
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }
}
