// GET /api/inquiries -> open support inquiries for the dashboard.
import { NextResponse } from 'next/server';
import { getOpenInquiries } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await getOpenInquiries();
    return NextResponse.json({ inquiries: rows });
  } catch (err) {
    // If the DB is not set up yet, return empty so the UI still renders its sample data.
    return NextResponse.json({ inquiries: [], error: String(err.message || err) });
  }
}
