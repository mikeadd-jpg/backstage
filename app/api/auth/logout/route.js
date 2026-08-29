// Clear the session cookie. POST so a stray link preview cannot sign anyone out.
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '../../../../lib/session.js';

export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
