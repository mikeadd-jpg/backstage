// GET /api/inquiries            -> open support inquiries
// GET /api/inquiries?status=resolved -> resolved history
import { NextResponse } from 'next/server';
import { getOpenInquiries, getResolvedInquiries } from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const status = new URL(req.url).searchParams.get('status');
    const rows = status === 'resolved' ? await getResolvedInquiries() : await getOpenInquiries();
    return NextResponse.json({ inquiries: rows });
  } catch (err) {
    return NextResponse.json({ inquiries: [], error: String(err.message || err) });
  }
}
