// Manage the sign-in allowlist. Every route here is admin only: that restriction is the
// entire difference between the two roles.
import { NextResponse } from 'next/server';
import { readSession, SESSION_COOKIE } from '../../../lib/session.js';
import { listUsers, upsertUser, removeUser } from '../../../lib/users.js';

export const dynamic = 'force-dynamic';

// Re-read the role from the cookie on every call rather than trusting the client. The
// cookie is signed, so a member cannot promote themselves by editing it.
async function requireAdmin(req) {
  const session = await readSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  if (session.role !== 'admin') {
    return { error: NextResponse.json({ error: 'Only an admin can manage users.' }, { status: 403 }) };
  }
  return { session };
}

export async function GET(req) {
  const { error, session } = await requireAdmin(req);
  if (error) return error;
  return NextResponse.json({ users: await listUsers(), me: session.email });
}

export async function POST(req) {
  const { error, session } = await requireAdmin(req);
  if (error) return error;
  try {
    const b = await req.json();
    const user = await upsertUser({
      email: b.email, role: b.role, name: b.name, addedBy: session.email,
    });
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}

export async function DELETE(req) {
  const { error, session } = await requireAdmin(req);
  if (error) return error;
  try {
    const email = String(new URL(req.url).searchParams.get('email') || '').toLowerCase();
    if (email === session.email) {
      return NextResponse.json({ error: 'You cannot remove your own access.' }, { status: 400 });
    }
    const removed = await removeUser(email);
    if (!removed) return NextResponse.json({ error: 'No such user.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
