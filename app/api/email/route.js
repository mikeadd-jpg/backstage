// GET /api/email -> subscriber counts and daily subscribe / unsubscribe history per brand,
//   plus every recorded daily count, for the Email tab to slice on the device.
// GET /api/email?flows=1&from=YYYY-MM-DD&to=YYYY-MM-DD -> flow performance for that range.
//
// The two are separate requests because flows are the expensive half: Klaviyo allows its
// flow report 2 calls a minute per account, so changing the period should cost only that,
// and only once per range (lib/klaviyo.js caches every answer in Postgres).
// Owner-only through the email area (lib/roles.js), and 404 to everyone else.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { klaviyoBrands, brandList, brandFlows, localToday } from '../../../lib/klaviyo.js';
import { getListSnapshots } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TZ = process.env.PROFIT_TZ || 'America/New_York';
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export async function GET(req) {
  const gate = await requireArea(req, 'email', { hide: true });
  if (gate.error) return gate.error;
  const q = req.nextUrl.searchParams;
  const brands = klaviyoBrands();

  try {
    if (q.get('flows')) {
      const from = q.get('from'), to = q.get('to');
      if (!ISO.test(from || '') || !ISO.test(to || '') || from > to) return json({ error: 'from and to must be dates, from first' }, 400);
      // Each brand is its own Klaviyo account with its own limits, so they run side by side.
      const flows = await Promise.all(brands.map((b) => brandFlows(b.key, from, to)));
      return json({ from, to, flows });
    }

    const [lists, snapshots] = await Promise.all([
      Promise.all(brands.map((b) => brandList(b.key))),
      getListSnapshots().catch(() => []),
    ]);
    const nameOf = Object.fromEntries(brands.map((b) => [b.key, b.name]));
    // Rows in the shape app/insights.jsx expects (brand name + date), one per day with motion.
    const rows = lists.flatMap((l) => (l.days || []).map((d) => ({ brand: l.name, ...d })));
    return json({
      today: localToday(TZ),
      brands: brands.map((b) => b.name),
      lists: lists.map(({ days, ...rest }) => rest),
      rows,
      snapshots: snapshots.map((s) => ({ brand: nameOf[s.brand] || s.brand, date: s.day, subscribers: s.subscribers })),
    });
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }
}
