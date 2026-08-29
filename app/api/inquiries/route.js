// GET /api/inquiries                 -> open support inquiries for the dashboard.
// GET /api/inquiries?status=resolved  -> the resolved history.
import { NextResponse } from 'next/server';
import { getOpenInquiries, getResolvedInquiries } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const status = new URL(req.url).searchParams.get('status');
    const rows = status === 'resolved' ? await getResolvedInquiries() : await getOpenInquiries();
    return NextResponse.json({ inquiries: rows });
  } catch (err) {
    // If the DB is not set up yet, return empty so the UI still renders its sample data.
    return NextResponse.json({ inquiries: [], error: String(err.message || err) });
  }
}
