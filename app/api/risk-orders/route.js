// GET /api/risk-orders -> at-risk orders for the proactive tab.
import { NextResponse } from 'next/server';
import { getRiskOrders } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ riskOrders: await getRiskOrders() });
  } catch (err) {
    return NextResponse.json({ riskOrders: [], error: String(err.message || err) });
  }
}
