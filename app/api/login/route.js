// POST /api/login { password } -> sets an HTTP-only auth cookie when the password matches.
// The password is stored server-side in APP_PASSWORD and never shipped to the browser.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  const { password } = await req.json().catch(() => ({}));
  const expected = process.env.APP_PASSWORD;

  if (!expected) {
    return NextResponse.json({ error: 'APP_PASSWORD is not set on the server' }, { status: 500 });
  }
  if (!password || password !== expected) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // The cookie value is the password itself; middleware compares it back to APP_PASSWORD.
  res.cookies.set('backstage_auth', expected, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
