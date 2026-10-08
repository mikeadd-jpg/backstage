// GET /api/canva/connect -> off to Canva's consent screen. Settings only, because the
// account connected here is where every mockup sent to Canva lands.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { baseUrl } from '../../../../lib/google.js';
import { startConnect } from '../../../../lib/canva.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  try {
    return NextResponse.redirect(await startConnect(baseUrl(req), gate.access.email), 302);
  } catch (err) {
    return NextResponse.redirect(
      baseUrl(req) + '/?canva_error=' + encodeURIComponent(String(err.message || err)) + '#settings', 302
    );
  }
}
