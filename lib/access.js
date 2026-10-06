// Who is asking, and what they may reach. Every API route behind the sign-in gate calls
// requireArea() before doing anything.
//
// The signed session cookie proves identity only. The role is read from allowed_users on
// each request (cached briefly), never from the cookie: the cookie lives for 14 days, so
// trusting the role in it would let a demoted or removed person keep their old access
// for up to two weeks. middleware.js still cannot check roles, because it runs on the
// Edge with no database, so the check lives here in the routes.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from './session.js';
import { findUser } from './users.js';
import { areasFor } from './roles.js';

const CACHE_MS = 30 * 1000;  // a role change or removal lands within 30 seconds
const cache = new Map();     // email -> { at, user|null }

async function lookup(email) {
  const hit = cache.get(email);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const user = await findUser(email);
  cache.set(email, { at: Date.now(), user });
  return user;
}

/** Drop a cached entry so a change made by an admin applies to the next request. */
export function forgetAccess(email) {
  cache.delete(String(email || '').trim().toLowerCase());
}

/** { email, name, role, areas } for the signed-in, still-allowed user, else null. */
export async function getAccess(req) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = await lookup(session.email);
  if (!user) return null;  // removed from the allowlist since signing in
  return {
    email: user.email,
    name: session.name || user.name || null,
    role: user.role,
    areas: areasFor(user.role),
  };
}

/**
 * Gate a route on one area (or any of several). Returns { access } when allowed, or
 * { error } holding the response to return. `hide: true` answers 404 instead of 403 so
 * the route does not even admit it exists (used for profit).
 */
export async function requireArea(req, area, { hide = false } = {}) {
  const access = await getAccess(req);
  if (!access) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const wanted = Array.isArray(area) ? area : [area];
  if (!wanted.some((a) => access.areas.includes(a))) {
    return {
      error: hide
        ? NextResponse.json({ error: 'not found' }, { status: 404 })
        : NextResponse.json({ error: "Your role doesn't include this." }, { status: 403 }),
    };
  }
  return { access };
}
