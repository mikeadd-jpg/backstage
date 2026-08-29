// Where Google sends the user back. Identity comes from Google; the allowlist decides
// whether that identity gets in. An unknown address is turned away here, not later.
import { NextResponse } from 'next/server';
import { exchangeGoogleCode, readState, redirectUri, baseUrl } from '../../../../../lib/google.js';
import { findUser, recordSignIn } from '../../../../../lib/users.js';
import { createSession, cookieOptions, SESSION_COOKIE } from '../../../../../lib/session.js';

export const dynamic = 'force-dynamic';

const deny = (req, reason) =>
  NextResponse.redirect(baseUrl(req) + '/login?error=' + encodeURIComponent(reason), 302);

export async function GET(req) {
  const sp = new URL(req.url).searchParams;
  if (sp.get('error')) return deny(req, 'Google sign-in was cancelled.');

  const state = await readState(sp.get('state'));
  if (!state) return deny(req, 'That sign-in link expired. Try again.');

  const code = sp.get('code');
  if (!code) return deny(req, 'Google did not return a sign-in code.');

  let who;
  try {
    who = await exchangeGoogleCode(code, redirectUri(req));
  } catch (err) {
    return deny(req, String(err.message || err));
  }

  const user = await findUser(who.email);
  if (!user) return deny(req, who.email + ' is not on the access list. Ask an admin to add you.');

  await recordSignIn(who.email, who.name);
  const res = NextResponse.redirect(baseUrl(req) + state.next, 302);
  res.cookies.set(SESSION_COOKIE, await createSession({
    email: user.email, role: user.role, name: who.name || user.name,
  }), cookieOptions);
  return res;
}
