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

export async function resolveInquiry(id) {
  await getPool().query("UPDATE inquiries SET status = 'resolved' WHERE id = $1", [id]);
}
