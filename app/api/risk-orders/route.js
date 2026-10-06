// GET /api/risk-orders -> at-risk orders for the proactive tab.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { getRiskOrders } from '../../../lib/db.js';
import { refreshRiskOrders } from '../../../lib/risk.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, 'risk');
  if (gate.error) return gate.error;
  try {
    return NextResponse.json({ riskOrders: await refreshRiskOrders(await getRiskOrders()) });
  } catch (err) {
    return NextResponse.json({ riskOrders: [], error: String(err.message || err) });
  }
}
