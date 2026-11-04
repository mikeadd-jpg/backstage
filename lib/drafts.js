// Drafts: every mockup, video ad and image ad the creative tools make, kept until someone
// deletes it (creative_drafts, files in Vercel Blob under drafts/). It replaced the old
// rule that generated work lived only in the browser tab: now closing the tab loses
// nothing, and the same drafts show on a phone or another computer.
//
// A draft is a draft or a favourite. Deleting one removes its row and every Blob file it
// owns (`files`). Mockups are saved by the server as they are generated; video and image
// drafts are saved by the builders, with their plan, the pictures it uses (copied to Blob
// so they outlive the tab) and the rendered file when there is one.
import { del, put } from '@vercel/blob';
import { dbQuery } from './db.js';

export const DRAFT_KINDS = ['mockup', 'video', 'image'];
export const DRAFT_PREFIX = 'drafts/';
const STATUSES = ['draft', 'favorite'];

const shape = (r) => ({
  id: r.id, brand: r.brand, kind: r.kind, status: r.status, title: r.title,
  plan: r.plan, assets: r.assets || [], output: r.output, source: r.source || {},
  by: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

const blobUrl = (u) => /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(String(u || ''));

// Every Blob file a draft points at, so deleting it can take them all.
function filesOf({ assets, output }) {
  const out = new Set();
  for (const a of assets || []) if (blobUrl(a.url) && String(a.url).includes('/' + DRAFT_PREFIX)) out.add(a.url);
  if (output) for (const k of ['url', 'poster']) if (blobUrl(output[k])) out.add(output[k]);
  return [...out];
}

// A picture reused in several drafts is one Blob file, so a file is only removed once no
// other draft still lists it.
async function removeUnshared(urls, exceptId) {
  if (!urls.length) return;
  const { rows } = await dbQuery(
    'SELECT DISTINCT unnest(files) AS u FROM creative_drafts WHERE id <> $1 AND files && $2', [Number(exceptId) || 0, urls]);
  const kept = new Set(rows.map((r) => r.u));
  const gone = urls.filter((u) => !kept.has(u));
  if (gone.length) await del(gone).catch((err) => { if (!/not.?found/i.test(String(err.message))) throw err; });
}

export async function listDrafts({ kinds = DRAFT_KINDS, brand = null, status = null, limit = 300 } = {}) {
  const { rows } = await dbQuery(
    `SELECT * FROM creative_drafts WHERE kind = ANY($1) AND ($2::text IS NULL OR brand = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY updated_at DESC LIMIT $4`, [kinds, brand, status, limit]);
  return rows.map(shape);
}

export async function getDraft(id) {
  const { rows } = await dbQuery('SELECT * FROM creative_drafts WHERE id = $1', [Number(id)]);
  return rows[0] ? shape(rows[0]) : null;
}

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Creates a draft, or updates `id` with whatever is given. Returns the saved draft. */
export async function saveDraft({ id, brand, kind, title, plan, assets, output, source, status, by }) {
  if (id) {
    const cur = await getDraft(id);
    if (!cur) throw new Error('That draft is gone.');
    const next = {
      title: title !== undefined ? clean(title, 140) : cur.title,
      plan: plan !== undefined ? plan : cur.plan,
      assets: assets !== undefined ? assets : cur.assets,
      output: output !== undefined ? output : cur.output,
      source: source !== undefined ? source : cur.source,
      status: STATUSES.includes(status) ? status : cur.status,
    };
    // Files the new version no longer uses are removed, so edits do not leave orphans.
    const before = filesOf(cur), after = filesOf(next);
    const dropped = before.filter((u) => !after.includes(u));
    await removeUnshared(dropped, cur.id).catch(() => {});
    const { rows } = await dbQuery(
      `UPDATE creative_drafts SET title = $2, plan = $3, assets = $4, output = $5, source = $6, status = $7,
         files = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [cur.id, next.title, JSON.stringify(next.plan), JSON.stringify(next.assets || []), JSON.stringify(next.output),
        JSON.stringify(next.source || {}), next.status, after]);
    return shape(rows[0]);
  }
  if (!DRAFT_KINDS.includes(kind)) throw new Error('Unknown draft kind.');
  const rec = { assets: assets || [], output: output || null };
  const { rows } = await dbQuery(
    `INSERT INTO creative_drafts (brand, kind, status, title, plan, assets, output, source, files, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [brand, kind, STATUSES.includes(status) ? status : 'draft', clean(title, 140), JSON.stringify(plan || null),
      JSON.stringify(rec.assets), JSON.stringify(rec.output), JSON.stringify(source || {}), filesOf(rec), by || null]);
  return shape(rows[0]);
}

export async function setDraftStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error('Unknown status.');
  await dbQuery('UPDATE creative_drafts SET status = $2, updated_at = now() WHERE id = $1', [Number(id), status]);
}

export async function deleteDraft(id) {
  const { rows } = await dbQuery('SELECT files FROM creative_drafts WHERE id = $1', [Number(id)]);
  if (!rows[0]) return;
  await dbQuery('DELETE FROM creative_drafts WHERE id = $1', [Number(id)]);
  await removeUnshared(rows[0].files || [], id);
}

/**
 * Saves a generated mockup (base64 PNG from lib/mockups.js) to Blob and Drafts. Shared by
 * the Mockups tab and the Inspiration batches (lib/recreate.js), so both keep the same
 * record: product, colour, source image, scene, variation and the exact prompt.
 */
export async function saveMockupDraft({ brand, product = {}, b64, sourceImage, scene, result = {}, by, extra = {} }) {
  const slug = String(product.handle || 'mockup').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  const file = await put(DRAFT_PREFIX + brand + '/mockups/' + slug + '.png', Buffer.from(b64, 'base64'),
    { access: 'public', addRandomSuffix: true, contentType: 'image/png' });
  return saveDraft({
    brand, kind: 'mockup', title: String(product.title || 'Mockup') + (product.color ? ' · ' + product.color : ''),
    output: { url: file.url, contentType: 'image/png' },
    source: { productId: product.id || null, handle: product.handle || null, title: product.title || null, color: product.color || null,
      sourceImage: sourceImage || null, scene: scene || null, variation: result.variation || null, prompt: result.prompt || null, ...extra },
    by,
  });
}

export const CLEANUP_DAYS = 60;

/**
 * Deletes plain drafts (not favourites) nobody has touched for CLEANUP_DAYS, with their
 * files unless another draft still uses them. Kept regardless: favourites, anything sent
 * to Meta (its results are read back), anything rendering, and mockups an ad draft from
 * the last CLEANUP_DAYS uses. The daily Inspiration cron runs it, at most 200 a day.
 */
export async function cleanupDrafts({ days = CLEANUP_DAYS, limit = 200 } = {}) {
  const { rows } = await dbQuery(
    `SELECT d.id FROM creative_drafts d
      WHERE d.status = 'draft' AND d.updated_at < now() - ($1 || ' days')::interval
        AND NOT (d.source ? 'meta')
        AND NOT (jsonb_typeof(d.output) = 'object' AND d.output ? 'job' AND d.output->'job'->>'stage' <> 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM creative_drafts a
           WHERE a.kind IN ('video','image') AND a.updated_at >= now() - ($1 || ' days')::interval
             AND a.assets @> jsonb_build_array(jsonb_build_object('draftId', d.id)))
      ORDER BY d.updated_at LIMIT $2`, [String(days), limit]);
  for (const { id } of rows) await deleteDraft(id);
  return { deleted: rows.length };
}
