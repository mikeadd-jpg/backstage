// Manage who can sign in and what role they hold. Needs the users area (admin, owner),
// and the finer rules in lib/roles.js roleChangeError: only an owner touches owners, and
// nobody changes their own access. The actor's role is read fresh from the database by
// requireArea, never from the cookie, so a demoted admin loses this immediately.
import { NextResponse } from 'next/server';
import { requireArea, forgetAccess } from '../../../lib/access.js';
import { listUsers, findUser, upsertUser, removeUser, bootstrapAdmin } from '../../../lib/users.js';
import { roleChangeError } from '../../../lib/roles.js';

export const dynamic = 'force-dynamic';

const norm = (e) => String(e || '').trim().toLowerCase();
const bad = (msg, status = 400) => NextResponse.json({ error: msg }, { status });

export async function GET(req) {
  const gate = await requireArea(req, 'users');
  if (gate.error) return gate.error;
  return NextResponse.json({ users: await listUsers(), me: gate.access.email, myRole: gate.access.role });
}

// Add someone, or change an existing person's role.
export async function POST(req) {
  const gate = await requireArea(req, 'users');
  if (gate.error) return gate.error;
  const { access } = gate;
  try {
    const b = await req.json();
    const email = norm(b.email);
    if (!email || !email.includes('@')) return bad('Enter a valid email address.');
    if (email === bootstrapAdmin()) return bad('That address is the permanent owner (ADMIN_EMAIL) and cannot be changed here.');
    const current = await findUser(email);
    const why = roleChangeError({
      actorEmail: access.email, actorRole: access.role,
      targetEmail: email, currentRole: current ? current.role : undefined, newRole: b.role,
    });
    if (why) return bad(why, 403);
    const user = await upsertUser({ email, role: b.role, name: b.name, addedBy: access.email });
    forgetAccess(email);
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    return bad(String(err.message || err));
  }
}

export async function DELETE(req) {
  const gate = await requireArea(req, 'users');
  if (gate.error) return gate.error;
  const { access } = gate;
  try {
    const email = norm(new URL(req.url).searchParams.get('email'));
    const current = await findUser(email);
    if (!current) return bad('No such user.', 404);
    const why = roleChangeError({
      actorEmail: access.email, actorRole: access.role, targetEmail: email, currentRole: current.role,
    });
    if (why) return bad(why, 403);
    await removeUser(email);  // still refuses the bootstrap owner itself
    forgetAccess(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return bad(String(err.message || err));
  }
}
