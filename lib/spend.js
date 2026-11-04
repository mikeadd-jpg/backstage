// What the creative tools spend, as estimates: every paid image (lib/mockups.js) and every
// server render (lib/serverRender.js) adds a row to spend_events, so a batch shows what it
// cost and Drafts shows the month so far. Estimates, not invoices: OpenAI and Vercel bill
// the real amounts. Claude calls are left out; they are cents next to the images.
//
// Image prices are per quality and can be set in env when the price list changes
// (MOCKUP_COST_LOW / _MEDIUM / _HIGH / _XHIGH / _MAX, dollars per image). Renders are the
// sandbox's minutes at RENDER_COST_PER_MIN (4 vCPUs with their memory, about a cent).
import { dbQuery } from './db.js';

const IMAGE_COST = { low: 0.02, medium: 0.07, high: 0.25, xhigh: 0.35, max: 0.5 };
export function imageCost(quality) {
  const q = String(quality || 'high').toLowerCase();
  const env = Number(process.env['MOCKUP_COST_' + q.toUpperCase()]);
  return Number.isFinite(env) && env > 0 ? env : IMAGE_COST[q] || IMAGE_COST.high;
}
export const renderCost = (seconds) => Math.round((Math.max(0, Number(seconds) || 0) / 60) * (Number(process.env.RENDER_COST_PER_MIN) || 0.011) * 10000) / 10000;

/** Never throws: a spend log that fails must not fail the work it records. */
export async function recordSpend({ kind, brand, batchId = null, draftId = null, units = 1, cost, by = null }) {
  try {
    await dbQuery(
      'INSERT INTO spend_events (kind, brand, batch_id, draft_id, units, cost_usd, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [kind, brand || null, batchId, draftId, units, Math.round((Number(cost) || 0) * 10000) / 10000, by]);
  } catch (err) {
    console.error('[spend] ' + err.message);
  }
}

/** { [batchId]: dollars } for the given batches. */
export async function batchSpend(ids) {
  if (!ids.length) return {};
  const { rows } = await dbQuery('SELECT batch_id, sum(cost_usd)::float AS c, count(*) FILTER (WHERE kind = \'image\')::int AS images FROM spend_events WHERE batch_id = ANY($1) GROUP BY batch_id', [ids]);
  return Object.fromEntries(rows.map((r) => [r.batch_id, { cost: Math.round(r.c * 100) / 100, images: r.images }]));
}

/** This calendar month (UTC) so far: total, images, renders and their costs. */
export async function monthSpend() {
  const { rows } = await dbQuery(
    `SELECT kind, count(*)::int AS n, sum(units)::float AS units, sum(cost_usd)::float AS c FROM spend_events
      WHERE created_at >= date_trunc('month', now()) GROUP BY kind`);
  const by = Object.fromEntries(rows.map((r) => [r.kind, { count: r.n, units: r.units, cost: Math.round(r.c * 100) / 100 }]));
  const total = Math.round(rows.reduce((t, r) => t + r.c, 0) * 100) / 100;
  return { total, images: by.image || { count: 0, cost: 0 }, renders: by.render || { count: 0, units: 0, cost: 0 } };
}
