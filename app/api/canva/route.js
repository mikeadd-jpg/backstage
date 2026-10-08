// GET  /api/canva                      -> is Canva set up and connected, and by whom
// POST /api/canva { action: 'disconnect' } -> forget the connection (and revoke it at Canva)
//
// Status is open to Mockups too, since that tab needs to know whether its button works.
// Disconnecting is settings only: it changes where everyone's uploads go.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { canvaStatus, disconnect } from '../../../lib/canva.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, ['settings', 'mockups']);
  if (gate.error) return gate.error;
  try {
    return NextResponse.json(await canvaStatus());
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();
    if (body.action === 'disconnect') {
      await disconnect();
      return NextResponse.json(await canvaStatus());
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
