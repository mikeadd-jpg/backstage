// GET /api/inquiries/thread?id=<inquiry id>
//   -> the whole Gmail conversation for an inquiry, our own replies included, and who a
//      reply sent from Backstage would go to and from (`plan`, null when sending is not
//      possible, with `cantSend` saying why).
// Read live from Gmail each time, so replies sent from Gmail itself show up too.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { getInquiryForReply } from '../../../../lib/db.js';
import { findMessageId, getThread, replyPlan } from '../../../../lib/gmail.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req) {
  const gate = await requireArea(req, 'inbox');
  if (gate.error) return gate.error;
  try {
    const id = new URL(req.url).searchParams.get('id');
    const inq = id && await getInquiryForReply(id);
    if (!inq) return NextResponse.json({ error: 'No such inquiry.' }, { status: 404 });

    const msgId = await findMessageId({ gmailId: inq.gmail_id, from: inq.from_email, subject: inq.subject, receivedAt: inq.received_at });
    if (!msgId) {
      return NextResponse.json({ messages: [], plan: null, cantSend: 'This email is not in the connected mailbox, so it can only be answered from wherever it arrived.' });
    }
    const messages = await getThread(msgId);
    let plan = null; let cantSend = null;
    try {
      const p = await replyPlan(msgId);
      plan = { to: p.to, from: p.from.email, fromName: p.from.name, subject: p.subject, hasSignature: Boolean(p.from.signature) };
    } catch (err) { cantSend = String(err.message || err); }
    return NextResponse.json({ messages, plan, cantSend });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
