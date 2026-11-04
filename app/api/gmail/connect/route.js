// GET /api/gmail/connect -> off to Google's consent screen to connect the mailbox
// Backstage reads and sends from. Settings only. Google sends the person back through
// the sign-in callback, which stores the mailbox (see lib/gmailAuth.js).
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { baseUrl } from '../../../../lib/google.js';
import { gmailConnectUrl } from '../../../../lib/gmailAuth.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  if (!process.env.GMAIL_CLIENT_ID) {
    return NextResponse.redirect(baseUrl(req) + '/?gmail_error=' + encodeURIComponent('GMAIL_CLIENT_ID is not set.') + '#settings', 302);
  }
  return NextResponse.redirect(await gmailConnectUrl(req, gate.access.email), 302);
}
