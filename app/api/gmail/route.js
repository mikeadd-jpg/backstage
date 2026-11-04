// GET  /api/gmail                          -> which mailbox Backstage reads and sends from
// POST /api/gmail { action: 'disconnect' } -> forget it (ingest falls back to the env token)
//
// Status is open to the Inbox too, so it can say whether Send works. Disconnecting is
// settings only: it changes which mailbox every inquiry comes from.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { gmailStatus, disconnectGmail } from '../../../lib/gmailAuth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, ['settings', 'inbox']);
  if (gate.error) return gate.error;
  try {
    return NextResponse.json(await gmailStatus());
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
      await disconnectGmail();
      return NextResponse.json(await gmailStatus());
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
