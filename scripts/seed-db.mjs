// One-shot database setup: `npm run seed`
//
// Applies db/schema.sql then db/seed.sql against DATABASE_URL. Both files are written to
// be safe to run more than once (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING), so
// re-running never overwrites anything you have edited in the Settings tab.
//
// No psql needed, and no dotenv: we read .env.local ourselves.
import { readFileSync } from 'fs';
import { Pool } from 'pg';

function loadEnvLocal() {
  let text;
  try { text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); }
  catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

async function count(pool, table) {
  try { return (await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n; }
  catch { return null; }
}

loadEnvLocal();
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or export it, then run again.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const read = (f) => readFileSync(new URL('../db/' + f, import.meta.url), 'utf8');

try {
  const host = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')).host;
  console.log('Connecting to ' + host + ' ...');

  console.log('Applying db/schema.sql ...');
  await pool.query(read('schema.sql'));

  const before = await count(pool, 'product_config');
  console.log('Applying db/seed.sql ...');
  await pool.query(read('seed.sql'));
  const after = await count(pool, 'product_config');

  const kids = (await pool.query(
    "SELECT brand_key, count(*)::int AS n FROM product_config WHERE garment_key LIKE '%\\_us' OR garment_key LIKE '%\\_uk' OR garment_key LIKE '%\\_ca' GROUP BY brand_key ORDER BY brand_key"
  )).rows;

  console.log('\nDone.');
  console.log('  product_config rows: ' + before + ' -> ' + after + ' (' + (after - before) + ' added)');
  for (const r of kids) console.log('  kids rows for ' + r.brand_key + ': ' + r.n);
  console.log('\nReview the seeded kids prices in the Settings tab before publishing anything.');
} catch (err) {
  console.error('\nFailed: ' + (err.message || err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
