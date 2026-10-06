// POST /api/risk-dismiss  { orderId, ruleKey }  -> clears an order from the At risk tab.
// It stays cleared unless a new kind of problem appears on that order.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { dismissRiskOrder } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const gate = await requireArea(req, 'risk');
  if (gate.error) return gate.error;
  try {
    const { orderId, ruleKey } = await req.json();
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 });
    await dismissRiskOrder(orderId, ruleKey || '');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
