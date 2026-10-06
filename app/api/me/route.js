// Who is signed in and which areas they can reach, for building the navigation. The role
// comes from the database (lib/access.js), not the cookie, so the menu reflects a role
// change on the next load. A 401 here means the person was removed: the page sends them
// to sign in again.
import { NextResponse } from 'next/server';
import { getAccess } from '../../../lib/access.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const access = await getAccess(req);
  if (!access) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({ user: access });
}
