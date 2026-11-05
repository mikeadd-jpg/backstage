// POST /api/inquiries/send { id, text } -> send `text` as the reply to an inquiry, in its
// Gmail thread, from the mailbox it arrived in and the brand address the customer wrote
// to (with that address's signature), then mark the inquiry resolved.
//
// This is the one place Backstage emails a customer, and only on a person's click in the
// Inbox, never over MCP: inquiry bodies are written by strangers, and an automated sender
// reading them is a prompt-injection path (see lib/mcp.js).
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { getInquiryForReply, resolveInquiry } from '../../../../lib/db.js';
import { findMessageId, sendReply } from '../../../../lib/gmail.js';
import { brandDomain } from '../../../../lib/brands.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req) {
  const gate = await requireArea(req, 'inbox');
  if (gate.error) return gate.error;
  try {
    const { id, text } = await req.json();
    const inq = id && await getInquiryForReply(id);
    if (!inq) return NextResponse.json({ error: 'No such inquiry.' }, { status: 404 });
    if (!String(text || '').trim()) return NextResponse.json({ error: 'The reply is empty.' }, { status: 400 });

    const found = await findMessageId({ gmailId: inq.gmail_id, from: inq.from_email, subject: inq.subject, receivedAt: inq.received_at, brandDomain: brandDomain(inq.brand) });
    if (!found) return NextResponse.json({ error: 'This email is not in the connected mailbox, so it cannot be answered from here.' }, { status: 409 });

    const sent = await sendReply(found.id, text, found.mailbox);
    // The reply is out; a failure to mark it resolved must not read as a failed send.
    let resolved = true;
    try { await resolveInquiry(inq.id); } catch { resolved = false; }
    return NextResponse.json({ ok: true, sent, resolved });
  } catch (err) {
    const msg = String(err.message || err);
    const scope = /insufficient|scope|permission/i.test(msg);
    return NextResponse.json({
      error: scope ? 'Gmail refused to send: the connected mailbox is missing the send permission. Reconnect Gmail in Settings.' : msg,
    }, { status: 500 });
  }
}
