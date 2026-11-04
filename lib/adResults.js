// How the ads Backstage made are doing. A video or image draft sent to Meta remembers its
// creative (and the paused ad, when one was made) in source.meta; once a day the lifetime
// results of every ad using those creatives are read back (creativeResults in lib/meta.js)
// and kept on the draft as source.meta.results, so Drafts shows what worked. The planners
// are then told which of this store's ads did best and worst (whatWorked), so new ads lean
// toward what sells here. Read only towards Meta.
import { dbQuery } from './db.js';
import { getDraft, saveDraft } from './drafts.js';
import { creativeResults, metaAccountFor } from './meta.js';

const MIN_SPEND = 5;         // below this an ad has not shown enough to judge
const KEEP_DAYS = 120;       // results are refreshed for drafts sent this recently

/** Notes on a draft what went to Meta: { creativeId?, adId?, adSetId?, videoId? }. */
export async function recordMeta(draftId, patch, by) {
  const d = await getDraft(draftId);
  if (!d || !['video', 'image'].includes(d.kind)) return null;
  const meta = { ...((d.source && d.source.meta) || {}), ...patch, at: (d.source && d.source.meta && d.source.meta.at) || new Date().toISOString(), ...(by ? { by } : {}) };
  return saveDraft({ id: d.id, source: { ...(d.source || {}), meta } });
}

/** Reads fresh results for every draft with a creative; the daily Inspiration cron calls it. */
export async function refreshAdResults() {
  const { rows } = await dbQuery(
    `SELECT id, brand, source FROM creative_drafts WHERE kind IN ('video','image') AND source->'meta'->>'creativeId' IS NOT NULL
       AND COALESCE((source->'meta'->>'at')::timestamptz, created_at) > now() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
  const byBrand = {};
  for (const r of rows) if (metaAccountFor(r.brand)) (byBrand[r.brand] || (byBrand[r.brand] = [])).push(r);
  let updated = 0;
  const errors = [];
  for (const [brand, list] of Object.entries(byBrand)) {
    let res;
    try { res = await creativeResults(brand, list.map((r) => r.source.meta.creativeId)); } catch (err) { errors.push(brand + ': ' + err.message); continue; }
    for (const r of list) {
      const found = res[String(r.source.meta.creativeId)];
      const results = found ? { ...found, at: new Date().toISOString() } : { ads: 0, at: new Date().toISOString() };
      const d = await getDraft(r.id);
      if (!d) continue;
      await saveDraft({ id: d.id, source: { ...d.source, meta: { ...d.source.meta, results } } });
      updated++;
    }
  }
  return { drafts: rows.length, updated, errors };
}

/**
 * A few lines for the planners on this store's own ads: the best and worst by ROAS among
 * those that have spent enough to judge. Empty when there is nothing to learn from yet.
 */
export async function whatWorked(brand) {
  const { rows } = await dbQuery(
    `SELECT title, kind, plan, source FROM creative_drafts WHERE brand = $1 AND kind IN ('video','image')
       AND (source->'meta'->'results'->>'spend')::numeric >= $2`, [brand, MIN_SPEND]).catch(() => ({ rows: [] }));
  if (rows.length < 2) return '';
  const line = (r) => {
    const x = r.source.meta.results;
    const p = r.plan || {};
    const shape = r.kind === 'video' ? 'video, ' + (p.template || '?') + (p.filter ? ', ' + p.filter + ' look' : '') : 'image, ' + (p.template || '?') + ' layout';
    const words = r.kind === 'image' ? p.headline : p.caption && p.caption.text ? p.caption.text : p.end && p.end.headline;
    return '"' + r.title + '" (' + shape + (words ? ', "' + String(words).slice(0, 60) + '"' : '') + (r.source.hook ? ', idea: ' + String(r.source.hook).slice(0, 100) : '') +
      '): $' + x.spend + ' spent, ' + x.purchases + ' purchases, ROAS ' + (x.roas == null ? 'n/a' : x.roas) + ', CTR ' + x.ctr + '%';
  };
  const ranked = rows.sort((a, b) => (b.source.meta.results.roas || 0) - (a.source.meta.results.roas || 0));
  const best = ranked.slice(0, 3);
  const worst = ranked.length > 4 ? ranked.slice(-2) : [];
  return ['How our own ads for this store have done on Meta (lean towards what worked, away from what did not; never copy a headline outright):',
    ...best.map((r) => '- Best: ' + line(r)), ...worst.map((r) => '- Weakest: ' + line(r))].join('\n');
}
