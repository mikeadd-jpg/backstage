// Competitors' Meta ads, fetched by Backstage itself from the Ad Library through
// ScrapeCreators (SCRAPECREATORS_API_KEY, pay-as-you-go credits, one per request). It
// replaced the Mac scheduled task, whose Ad Library search returned at most 50 ads per
// Page and never the image or text.
//
// One run (the daily cron /api/inspiration-refresh, or Refresh in the tab) reads each
// active competitor's running ads in the Ad Library's impressions order, highest first,
// up to MAX_PAGES requests per competitor, and upserts them into competitor_ads. Two
// things follow from that order and are easy to break:
//   - An ad is only marked ended when the run read ALL of that competitor's running ads.
//     A capped read did not see the tail, and not seeing an ad is not proof it stopped.
//   - `impression_rank` is the ad's position in that read, Meta's only reach signal for
//     US commercial ads. It is rewritten every run.
//
// Media is saved to Vercel Blob the first time an ad is seen (saveMedia), because Meta's
// image and video links are signed and expire within days. Until that works the ad keeps
// Meta's latest links in `media_source`, refreshed every run while it is live, and the
// next run retries (up to MAX_MEDIA_TRIES). The whole run works to a time budget well
// inside the route's maxDuration; whatever is left goes on the next run.
//
// Ads the competitor read does not reach (past MAX_PAGES, a failed brand, or the ads
// imported from the old sheet, which never had media) are looked up one by one by id
// (backfill, BACKFILL_PER_RUN a run, 1 credit each): that saves their media links, or
// marks them ended. Without it an imported ad would sit "running" with no picture forever.
//
// ScrapeCreators answers 429s and 500s from its own upstream ("Proxy rejected the CONNECT
// tunnel") now and then; those are retried twice with a pause before a brand counts as
// failed.
import { put } from '@vercel/blob';
import { dbQuery } from './db.js';

const API = 'https://api.scrapecreators.com/v1/facebook/adLibrary/company/ads';
const AD_API = 'https://api.scrapecreators.com/v1/facebook/adLibrary/ad';
const BACKFILL_PER_RUN = Number(process.env.ADLIB_BACKFILL_PER_RUN) || 150;
const MEDIA_AT_ONCE = 6;
const MAX_PAGES = Number(process.env.ADLIB_MAX_PAGES) || 5;     // requests per competitor per run
const MAX_MEDIA_TRIES = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const IMAGES_PER_AD = 4;                                          // a carousel keeps its first four cards

export const adLibraryConfigured = () => Boolean(process.env.SCRAPECREATORS_API_KEY);

// Runs `fn` over `items` with at most `n` in flight. A throw stops new work and rejects.
async function pool(items, n, fn) {
  let i = 0, failed = null;
  const worker = async () => {
    while (i < items.length && !failed) {
      const item = items[i++];
      try { await fn(item); } catch (err) { failed = err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failed) throw failed;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One ScrapeCreators call, retried on its transient upstream failures (429, 5xx).
async function scGet(url, init = {}) {
  let last;
  for (const pause of [0, 2500, 7000]) {
    if (pause) await wait(pause);
    const res = await fetch(url, { ...init, headers: { 'x-api-key': process.env.SCRAPECREATORS_API_KEY, ...(init.headers || {}) } });
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new Error('ScrapeCreators refused the API key. Check SCRAPECREATORS_API_KEY.');
    if (res.status === 402) throw new Error('ScrapeCreators is out of credits. Top up at app.scrapecreators.com.');
    if (res.ok && data && data.success !== false) return { res, data };
    last = { res, data };
    if (!(res.status === 429 || res.status >= 500)) break;
  }
  const { res, data } = last;
  const err = new Error('ScrapeCreators answered ' + res.status + (data && (data.message || data.error) ? ': ' + (data.message || data.error) : ''));
  err.status = res.status;
  throw err;
}

async function fetchPage(pageId, cursor) {
  const q = new URLSearchParams({ pageId, status: 'ACTIVE', sort_by: 'total_impressions' });
  // Long cursors break a GET (413/414), so they go in a POST body, as the API advises.
  const { data } = cursor
    ? await scGet(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, status: 'ACTIVE', sort_by: 'total_impressions', cursor }) })
    : await scGet(API + '?' + q);
  return { results: Array.isArray(data.results) ? data.results : [], cursor: data.cursor || null, creditsLeft: data.credits_remaining ?? null };
}

// One ad by id: { ad (parsed, with `active`), creditsLeft }, or { gone: true } when the Ad
// Library no longer has it. The single-ad answer names its fields in camelCase.
async function fetchAd(adId, competitor) {
  try {
    const { data } = await scGet(AD_API + '?' + new URLSearchParams({ id: adId }));
    const ad = parseAdResult({
      ad_archive_id: data.adArchiveID || adId, page_id: data.pageID || data.pageId || (data.snapshot && data.snapshot.page_id),
      start_date: data.startDate, end_date: data.endDate, collation_id: data.collationID, collation_count: data.collationCount,
      snapshot: data.snapshot,
    }, competitor);
    return { ad: { ...ad, active: data.isActive !== false }, creditsLeft: data.credits_remaining ?? null };
  } catch (err) {
    if (err.status === 404) return { gone: true };
    throw err;
  }
}

const day = (unix) => (unix ? new Date(Number(unix) * 1000).toISOString().slice(0, 10) : null);
const first = (...xs) => xs.find((x) => typeof x === 'string' && x.trim()) || '';

// What we keep from one Ad Library result: text, dates, and Meta's media links.
export function parseAdResult(r, competitor) {
  const s = r.snapshot || {};
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const card0 = cards[0] || {};
  const images = [];
  for (const c of cards) { const u = first(c.original_image_url, c.resized_image_url); if (u) images.push(u); }
  for (const i of [...(s.images || []), ...(s.extra_images || [])]) { const u = first(i.original_image_url, i.resized_image_url); if (u) images.push(u); }
  const vids = [...(s.videos || []), ...(s.extra_videos || []), ...cards.filter((c) => c.video_hd_url || c.video_sd_url)];
  const video = vids.map((v) => ({ hd: first(v.video_hd_url), sd: first(v.video_sd_url), poster: first(v.video_preview_image_url) }))
    .find((v) => v.hd || v.sd) || null;
  return {
    adId: String(r.ad_archive_id || r.ad_id || ''),
    pageId: String(r.page_id || s.page_id || ''),
    competitor,
    headline: first(s.title, card0.title, s.link_description).slice(0, 500),
    body: first(s.body && s.body.text, card0.body, s.caption).slice(0, 4000),
    linkUrl: first(s.link_url, card0.link_url) || null,
    cta: first(s.cta_text, card0.cta_text) || null,
    format: s.display_format || null,
    startDate: day(r.start_date),
    endDate: day(r.end_date),
    collationId: r.collation_id ? String(r.collation_id) : null,
    collationCount: Number(r.collation_count) || null,
    source: { images: [...new Set(images)].slice(0, IMAGES_PER_AD), video },
  };
}

async function upsertAd(ad, rank, runStart) {
  const { rows } = await dbQuery(
    `INSERT INTO competitor_ads (ad_id, page_id, competitor, headline, body, link_url, cta, display_format,
        start_date, end_date, first_seen, last_seen, active, collation_id, collation_count, impression_rank, media_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,true,$12,$13,$14,$15)
     ON CONFLICT (ad_id) DO UPDATE SET
       competitor = EXCLUDED.competitor, headline = EXCLUDED.headline, body = EXCLUDED.body,
       link_url = EXCLUDED.link_url, cta = EXCLUDED.cta, display_format = EXCLUDED.display_format,
       start_date = COALESCE(EXCLUDED.start_date, competitor_ads.start_date), end_date = EXCLUDED.end_date,
       last_seen = EXCLUDED.last_seen, active = true, collation_id = EXCLUDED.collation_id,
       collation_count = EXCLUDED.collation_count, impression_rank = EXCLUDED.impression_rank,
       media_source = CASE WHEN competitor_ads.media_saved THEN competitor_ads.media_source ELSE EXCLUDED.media_source END
     RETURNING (xmax = 0) AS inserted`,
    [ad.adId, ad.pageId, ad.competitor, ad.headline, ad.body, ad.linkUrl, ad.cta, ad.format,
      ad.startDate, ad.endDate, runStart, ad.collationId, ad.collationCount, rank, JSON.stringify(ad.source)]);
  return rows[0] && rows[0].inserted;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

async function copyToBlob(src, pathname, maxBytes) {
  const res = await fetch(src, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error('media ' + res.status);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > maxBytes) throw new Error('media too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('media too large');
  const blob = await put(pathname + '.' + (EXT[type] || 'bin'), buf, { access: 'public', addRandomSuffix: true, contentType: type || undefined });
  return blob.url;
}

// Our own copies of an ad's video (HD, or SD as a fallback, with its poster frame) and up
// to IMAGES_PER_AD images (a carousel's first cards), so they outlive Meta's links. All or
// nothing per ad: a half-saved ad is retried whole next run.
async function saveMedia(row) {
  const src = row.media_source || {};
  const base = 'inspiration/ads/' + row.page_id + '/' + row.ad_id;
  const media = [];
  const v = src.video;
  if (v && (v.hd || v.sd || v.src)) {
    const poster = v.poster ? await copyToBlob(v.poster, base + '-poster', MAX_IMAGE_BYTES) : null;
    // HD first; SD when HD is missing, too large or fails. (`src` is an older saved shape.)
    let url = null;
    for (const from of [v.hd, v.sd, v.src].filter(Boolean)) {
      try { url = await copyToBlob(from, base + '-video', MAX_VIDEO_BYTES); break; } catch { /* next quality */ }
    }
    if (!url) throw new Error('video could not be saved');
    media.push({ kind: 'video', url, poster });
  }
  for (const [i, u] of (src.images || []).entries()) media.push({ kind: 'image', url: await copyToBlob(u, base + '-' + i, MAX_IMAGE_BYTES) });
  await dbQuery('UPDATE competitor_ads SET media = $2, media_saved = true WHERE ad_id = $1', [row.ad_id, JSON.stringify(media)]);
  return media.length;
}

/**
 * One fetch run over the active competitors, least recently checked first, within
 * `budgetMs`. With `competitorId`, only that competitor (paused or not), its unread ads
 * and its media: the scan the tab runs right after a competitor is added. Returns the run
 * summary also written to inspiration_runs.
 */
export async function refreshCompetitorAds({ budgetMs = 240000, competitorId = null } = {}) {
  if (!adLibraryConfigured()) throw new Error('SCRAPECREATORS_API_KEY is not set. Add it in Vercel to fetch competitor ads.');
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const { rows: [run] } = await dbQuery('INSERT INTO inspiration_runs DEFAULT VALUES RETURNING id, started_at');
  const sum = { checked: 0, newAds: 0, ended: 0, mediaSaved: 0, credits: 0, creditsLeft: null, errors: [] };

  const { rows: comps } = competitorId
    ? await dbQuery('SELECT * FROM competitors WHERE id = $1', [Number(competitorId)])
    : await dbQuery('SELECT * FROM competitors WHERE active AND page_id IS NOT NULL ORDER BY checked_at NULLS FIRST, id');
  // Found on a phone capture and not looked up yet: nothing to fetch until it has a Page.
  if (competitorId && comps[0] && !comps[0].page_id) throw new Error('Add ' + comps[0].name + '\'s Ad Library link first.');
  // A single scan keeps the backfill and media passes to that competitor's own ads.
  const onlyPage = competitorId ? (comps[0] && comps[0].page_id) || '-' : null;
  for (const c of comps) {
    if (left() < 40000) break;          // leave room for media and the last write
    const runStart = new Date();
    let cursor = null, pages = 0, rank = 0, capped = false, error = null;
    try {
      do {
        const page = await fetchPage(c.page_id, cursor);
        pages++; sum.credits++;
        if (page.creditsLeft != null) sum.creditsLeft = page.creditsLeft;
        for (const r of page.results) {
          const ad = parseAdResult(r, c.name);
          if (!ad.adId) continue;
          ad.pageId = ad.pageId || c.page_id;
          if (await upsertAd(ad, ++rank, runStart)) sum.newAds++;
        }
        cursor = page.cursor && page.results.length ? page.cursor : null;
        if (cursor && pages >= MAX_PAGES) { capped = true; break; }
      } while (cursor && left() > 30000);
      if (cursor && !capped) capped = true;     // stopped for time: also a partial read
      if (!capped) {
        const { rowCount } = await dbQuery(
          'UPDATE competitor_ads SET active = false WHERE page_id = $1 AND active AND last_seen < $2', [c.page_id, runStart]);
        sum.ended += rowCount;
      }
    } catch (err) {
      error = String(err.message || err);
      sum.errors.push(c.name + ': ' + error);
      // Key or credit trouble will fail every competitor the same way.
      if (/API key|out of credits/.test(error)) {
        await dbQuery('UPDATE competitors SET checked_at = now(), last_error = $2 WHERE id = $1', [c.id, error]);
        break;
      }
    }
    await dbQuery('UPDATE competitors SET checked_at = now(), last_error = $2, capped = $3 WHERE id = $1', [c.id, error, capped]);
    sum.checked++;
  }

  // Backfill: "running" ads this run did not read and that have no media links yet,
  // looked up one by one (five at a time), best ranked and newest first.
  if (left() > 60000) {
    const { rows: unknown } = await dbQuery(
      `SELECT ad_id, competitor FROM competitor_ads WHERE active AND NOT media_saved AND media_source IS NULL
         AND ($2::text IS NULL OR page_id = $2)
        ORDER BY impression_rank NULLS LAST, first_seen DESC LIMIT $1`, [BACKFILL_PER_RUN, onlyPage]);
    sum.backfilled = 0;
    await pool(unknown, 5, async (row) => {
      if (left() < 45000) return;
      try {
        const r = await fetchAd(row.ad_id, row.competitor);
        sum.credits++;
        if (r.creditsLeft != null) sum.creditsLeft = r.creditsLeft;
        if (r.gone || !r.ad.active) {
          await dbQuery('UPDATE competitor_ads SET active = false, end_date = COALESCE($2::date, end_date) WHERE ad_id = $1', [row.ad_id, r.ad ? r.ad.endDate : null]);
          sum.ended++;
        } else {
          const a = r.ad;
          await dbQuery(
            `UPDATE competitor_ads SET media_source = $2, headline = CASE WHEN $3 <> '' THEN $3 ELSE headline END,
               body = CASE WHEN $4 <> '' THEN $4 ELSE body END, link_url = COALESCE($5, link_url), cta = COALESCE($6, cta),
               display_format = COALESCE($7, display_format), start_date = COALESCE($8::date, start_date),
               collation_count = COALESCE($9, collation_count), last_seen = now() WHERE ad_id = $1`,
            [row.ad_id, JSON.stringify(a.source), a.headline, a.body, a.linkUrl, a.cta, a.format, a.startDate, a.collationCount]);
          sum.backfilled++;
        }
      } catch (err) {
        if (/API key|out of credits/.test(String(err.message))) throw err;
      }
    }).catch((err) => sum.errors.push('Backfill: ' + String(err.message || err)));
  }

  // Media for anything not yet saved, best ranked and newest first, six at a time, as time
  // allows.
  const { rows: pending } = await dbQuery(
    `SELECT ad_id, page_id, media_source FROM competitor_ads
      WHERE NOT media_saved AND media_tries < $1 AND media_source IS NOT NULL AND ($2::text IS NULL OR page_id = $2)
      ORDER BY active DESC, impression_rank NULLS LAST, first_seen DESC LIMIT 1500`, [MAX_MEDIA_TRIES, onlyPage]);
  await pool(pending, MEDIA_AT_ONCE, async (row) => {
    if (left() < 15000) return;
    try {
      await saveMedia(row);
      sum.mediaSaved++;
    } catch {
      await dbQuery('UPDATE competitor_ads SET media_tries = media_tries + 1 WHERE ad_id = $1', [row.ad_id]);
    }
  });

  await dbQuery(
    `UPDATE inspiration_runs SET finished_at = now(), checked = $2, new_ads = $3, ended_ads = $4, media_saved = $5,
       credits_used = $6, credits_left = $7, errors = $8 WHERE id = $1`,
    [run.id, sum.checked, sum.newAds, sum.ended, sum.mediaSaved, sum.credits, sum.creditsLeft, sum.errors.join('\n') || null]);
  return { ...sum, ms: Date.now() - t0 };
}
