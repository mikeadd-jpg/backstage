import { Pool } from 'pg';

let pool;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export async function alreadyProcessed(gmailId) {
  const { rows } = await getPool().query('SELECT 1 FROM inquiries WHERE gmail_id = $1', [gmailId]);
  return rows.length > 0;
}

export async function insertInquiry(rec) {
  const q = `
    INSERT INTO inquiries
      (gmail_id, brand, from_email, to_email, subject, received_at, is_support,
       issue_type, summary, body, order_number, order_status, needs_action, draft_reply, confidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (gmail_id) DO NOTHING`;
  await getPool().query(q, [
    rec.gmailId, rec.brand, rec.fromEmail, rec.toEmail, rec.subject, rec.receivedAt,
    rec.isSupport, rec.issueType, rec.summary, rec.body, rec.orderNumber,
    rec.orderStatus ? JSON.stringify(rec.orderStatus) : null,
    rec.needsAction, rec.draftReply, rec.confidence,
  ]);
}

export async function getOpenInquiries() {
  const { rows } = await getPool().query(
    `SELECT id, brand, from_email, to_email, subject, received_at, issue_type, summary, body,
            order_number, order_status, needs_action, draft_reply, confidence
     FROM inquiries
     WHERE status = 'open' AND is_support = true
     ORDER BY received_at DESC
     LIMIT 200`
  );
  return rows;
}

// ---- Proactive risk orders ----

export async function replaceRiskOrders(rows) {
  const pool = getPool();
  await pool.query('DELETE FROM risk_orders');
  for (const r of rows) {
    await pool.query(
      `INSERT INTO risk_orders
        (order_id, brand, order_number, customer_name, customer_email, items, reasons, rule_key, severity, age_days, shopify_admin_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (order_id) DO UPDATE SET
         items = EXCLUDED.items, reasons = EXCLUDED.reasons, rule_key = EXCLUDED.rule_key, severity = EXCLUDED.severity,
         age_days = EXCLUDED.age_days, detected_at = now()`,
      [r.orderId, r.brand, r.orderNumber, r.customerName, r.customerEmail, r.items,
       JSON.stringify(r.reasons), r.ruleKey, r.severity, r.ageDays, r.shopifyAdminUrl]
    );
  }
}

export async function getRiskOrders() {
  const { rows } = await getPool().query(
    `SELECT order_id, brand, order_number, customer_name, customer_email, items,
            reasons, rule_key, severity, age_days, shopify_admin_url
     FROM risk_orders
     ORDER BY (severity = 'high') DESC, age_days DESC
     LIMIT 200`
  );
  return rows;
}

export async function getDismissals() {
  const { rows } = await getPool().query('SELECT order_id, rule_key FROM risk_dismissals');
  const m = {};
  for (const r of rows) m[r.order_id] = r.rule_key;
  return m;
}

export async function dismissRiskOrder(orderId, ruleKey) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO risk_dismissals (order_id, rule_key) VALUES ($1,$2)
     ON CONFLICT (order_id) DO UPDATE SET rule_key = EXCLUDED.rule_key, dismissed_at = now()`,
    [orderId, ruleKey]
  );
  await pool.query('DELETE FROM risk_orders WHERE order_id = $1', [orderId]);
}

export async function pruneDismissals(orderIds) {
  const pool = getPool();
  if (!orderIds.length) { await pool.query('DELETE FROM risk_dismissals'); return; }
  await pool.query('DELETE FROM risk_dismissals WHERE NOT (order_id = ANY($1))', [orderIds]);
}

// ---- Slack alerting for risk orders ----
// Mirrors the dismissal trio above. getNotifiedRisks/markRisksNotified/pruneRiskNotifications
// are what stop a standing problem from re-alerting on every four-hourly scan.

export async function getNotifiedRisks() {
  const { rows } = await getPool().query('SELECT order_id, rule_key FROM risk_notifications');
  const m = {};
  for (const r of rows) m[r.order_id] = r.rule_key;
  return m;
}

export async function markRisksNotified(rows) {
  if (!rows.length) return;
  const pool = getPool();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO risk_notifications (order_id, rule_key) VALUES ($1,$2)
       ON CONFLICT (order_id) DO UPDATE SET rule_key = EXCLUDED.rule_key, notified_at = now()`,
      [r.orderId, r.ruleKey]
    );
  }
}

// Forget orders that are no longer flagged at all, so if the same problem returns weeks
// later it alerts again rather than staying silent forever.
export async function pruneRiskNotifications(orderIds) {
  const pool = getPool();
  if (!orderIds.length) { await pool.query('DELETE FROM risk_notifications'); return; }
  await pool.query('DELETE FROM risk_notifications WHERE NOT (order_id = ANY($1))', [orderIds]);
}

export async function resolveInquiry(id) {
  await getPool().query("UPDATE inquiries SET status = 'resolved', resolved_at = now() WHERE id = $1", [id]);
}

export async function reopenInquiry(id) {
  await getPool().query("UPDATE inquiries SET status = 'open', resolved_at = NULL WHERE id = $1", [id]);
}

// Resolved history. Rows resolved before resolved_at was being stamped sort last by
// their received date rather than disappearing.
export async function getResolvedInquiries() {
  const { rows } = await getPool().query(
    `SELECT id, brand, from_email, to_email, subject, received_at, issue_type, summary, body,
            order_number, order_status, needs_action, draft_reply, confidence, resolved_at
     FROM inquiries
     WHERE status = 'resolved' AND is_support = true
     ORDER BY resolved_at DESC NULLS LAST, received_at DESC
     LIMIT 300`
  );
  return rows;
}

// ---- Stores / product config / voices / settings ----

export async function getStores() {
  const { rows } = await getPool().query(
    'SELECT brand_key, name, printify_shop_id, is_default FROM stores ORDER BY is_default DESC, name'
  );
  return rows;
}
export async function upsertStore(s) {
  await getPool().query(
    `INSERT INTO stores (brand_key, name, printify_shop_id, is_default)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (brand_key) DO UPDATE SET name=EXCLUDED.name,
       printify_shop_id=EXCLUDED.printify_shop_id, is_default=EXCLUDED.is_default`,
    [s.brandKey, s.name, s.printifyShopId, !!s.isDefault]
  );
}
export async function getStoreByShopId(shopId) {
  const { rows } = await getPool().query(
    'SELECT brand_key, name, printify_shop_id FROM stores WHERE printify_shop_id = $1', [String(shopId)]
  );
  return rows[0] || null;
}

export async function getProductConfig(brandKey) {
  const { rows } = await getPool().query(
    'SELECT garment_key, price_cents, tags FROM product_config WHERE brand_key = $1', [brandKey]
  );
  const map = {};
  for (const r of rows) {
    map[r.garment_key] = {
      price_cents: r.price_cents,
      tags: String(r.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    };
  }
  return map;
}
export async function getAllProductConfig() {
  const { rows } = await getPool().query('SELECT brand_key, garment_key, price_cents, tags FROM product_config');
  return rows;
}
export async function upsertProductConfig(c) {
  await getPool().query(
    `INSERT INTO product_config (brand_key, garment_key, price_cents, tags)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (brand_key, garment_key) DO UPDATE SET price_cents=EXCLUDED.price_cents, tags=EXCLUDED.tags`,
    [c.brandKey, c.garmentKey, c.priceCents, c.tags]
  );
}

// Copy one brand's pricing, tags and voice onto another brand key, so a new store does
// not start with 19 empty rows. Non-destructive: anything the target already has is left
// alone, so re-running only fills gaps and never clobbers an edit. Tags carry the brand
// name as a token, so that token is swapped for the new key on the way across.
export async function copyBrandConfig(fromBrandKey, toBrandKey) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const { rows: src } = await client.query(
      'SELECT garment_key, price_cents, tags FROM product_config WHERE brand_key = $1', [fromBrandKey]
    );
    let copied = 0;
    for (const r of src) {
      const tags = String(r.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.toLowerCase() === String(fromBrandKey).toLowerCase() ? toBrandKey : t))
        .join(', ');
      const res = await client.query(
        `INSERT INTO product_config (brand_key, garment_key, price_cents, tags)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (brand_key, garment_key) DO NOTHING`,
        [toBrandKey, r.garment_key, r.price_cents, tags]
      );
      copied += res.rowCount;
    }

    const { rows: v } = await client.query(
      'SELECT voice FROM brand_voices WHERE brand_key = $1', [fromBrandKey]
    );
    let voiceCopied = 0;
    if (v[0]) {
      const res = await client.query(
        `INSERT INTO brand_voices (brand_key, voice) VALUES ($1,$2)
         ON CONFLICT (brand_key) DO NOTHING`,
        [toBrandKey, v[0].voice]
      );
      voiceCopied = res.rowCount;
    }

    await client.query('COMMIT');
    return { available: src.length, copied, skipped: src.length - copied, voiceCopied: voiceCopied > 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getVoiceRow(brandKey) {
  const { rows } = await getPool().query('SELECT voice FROM brand_voices WHERE brand_key = $1', [brandKey]);
  return rows[0] ? rows[0].voice : null;
}
export async function getAllVoices() {
  const { rows } = await getPool().query('SELECT brand_key, voice FROM brand_voices');
  const map = {};
  for (const r of rows) map[r.brand_key] = r.voice;
  return map;
}
export async function upsertVoice(brandKey, voice) {
  await getPool().query(
    `INSERT INTO brand_voices (brand_key, voice) VALUES ($1,$2)
     ON CONFLICT (brand_key) DO UPDATE SET voice=EXCLUDED.voice`,
    [brandKey, voice]
  );
}

export async function getSetting(key) {
  const { rows } = await getPool().query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}
export async function setSetting(key, value) {
  await getPool().query(
    `INSERT INTO app_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value]
  );
}

// Which of these gmail ids are already in the database? One query instead of N.
export async function filterUnprocessed(ids) {
  if (!ids.length) return [];
  const { rows } = await getPool().query(
    'SELECT gmail_id FROM inquiries WHERE gmail_id = ANY($1)', [ids]
  );
  const seen = new Set(rows.map((r) => r.gmail_id));
  return ids.filter((id) => !seen.has(id));
}
