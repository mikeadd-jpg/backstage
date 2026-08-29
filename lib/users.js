// The sign-in allowlist. Google proves identity; this decides who is let in.
//
// ADMIN_EMAIL is the bootstrap and the lockout recovery: the table starts empty, so
// without it nobody could sign in and nobody could add anyone. That address is always
// treated as an admin, and is written into the table on first sign-in. If you ever lock
// yourself out, changing that one env var puts you back in.
import { Pool } from 'pg';

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

const norm = (e) => String(e || '').trim().toLowerCase();

export function bootstrapAdmin() {
  return norm(process.env.ADMIN_EMAIL) || null;
}

export async function listUsers() {
  const { rows } = await getPool().query(
    'SELECT email, role, name, added_by, last_seen, created_at FROM allowed_users ORDER BY role, email'
  );
  return rows;
}

// Returns { email, role, name } for someone allowed in, or null. The bootstrap admin is
// allowed even when the table has no row for them yet.
export async function findUser(email) {
  const e = norm(email);
  if (!e) return null;
  const { rows } = await getPool().query(
    'SELECT email, role, name FROM allowed_users WHERE email = $1', [e]
  );
  if (rows[0]) {
    // The bootstrap address outranks whatever the table says, so a demotion cannot lock you out.
    return e === bootstrapAdmin() ? { ...rows[0], role: 'admin' } : rows[0];
  }
  if (e === bootstrapAdmin()) return { email: e, role: 'admin', name: null };
  return null;
}

export async function upsertUser({ email, role, name, addedBy }) {
  const e = norm(email);
  if (!e || !e.includes('@')) throw new Error('A valid email address is required.');
  const r = role === 'admin' ? 'admin' : 'member';
  await getPool().query(
    `INSERT INTO allowed_users (email, role, name, added_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role,
       name = COALESCE(EXCLUDED.name, allowed_users.name)`,
    [e, r, name || null, addedBy || null]
  );
  return { email: e, role: r };
}

export async function recordSignIn(email, name) {
  const e = norm(email);
  await getPool().query(
    `INSERT INTO allowed_users (email, role, name, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET last_seen = now(),
       name = COALESCE(EXCLUDED.name, allowed_users.name)`,
    [e, e === bootstrapAdmin() ? 'admin' : 'member', name || null]
  );
}

export async function removeUser(email) {
  const e = norm(email);
  if (e === bootstrapAdmin()) throw new Error('The bootstrap admin cannot be removed. Change ADMIN_EMAIL instead.');
  const { rowCount } = await getPool().query('DELETE FROM allowed_users WHERE email = $1', [e]);
  return rowCount > 0;
}
