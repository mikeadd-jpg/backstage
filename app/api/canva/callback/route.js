// GET /api/canva/callback -> where Canva sends the user back after consent. Behind the
// sign-in gate like any page, and must be registered as a redirect URL on the Canva
// integration for every origin in use.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../../lib/access.js';
import { baseUrl } from '../../../../lib/google.js';
import { finishConnect } from '../../../../lib/canva.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const back = (q) => NextResponse.redirect(baseUrl(req) + '/?' + q + '#settings', 302);
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;

  const sp = new URL(req.url).searchParams;
  if (sp.get('error')) {
    return back('canva_error=' + encodeURIComponent('Canva connection was cancelled (' + sp.get('error') + ').'));
  }
  try {
    await finishConnect(baseUrl(req), { code: sp.get('code'), state: sp.get('state'), email: gate.access.email });
    return back('canva=connected');
  } catch (err) {
    return back('canva_error=' + encodeURIComponent(String(err.message || err)));
  }
}
