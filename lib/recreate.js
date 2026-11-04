// Recreate from Inspiration, in bulk: pick competitor ads (or phone captures) you like, or
// start from a brief of our own (createBriefBatch),
// and Backstage makes our own version of each, using our products and the brand kit, and
// keeps everything in Drafts. It runs on the server, step by step, so it can be started
// from a phone and left.
//
// Each picked ad goes through:
//   analyze   Claude breaks the ad down (analyzeAd in lib/inspiration.js, the same as
//             "How would I build this?"): hook, which of our tools, a product search term,
//             headline ideas and an original scene brief
//   products  our products matching that search term, each with its original Printify
//             mockup (lib/printifyMockups.js) or its Shopify image (Wallspoke)
//   mockups   one lifestyle mockup per product from Claude's scene (lib/mockups.js), each
//             saved to Drafts as it lands
//   plan      Claude plans one video or image ad from those mockups and the brand kit
//             (planVideos / planStills, the builders' own planners), saved as a draft
//   render    a server render of that draft (lib/serverRender.js)
//
// **Their creative never goes to an image model.** Only Claude sees the competitor's
// picture, to understand the idea; the image model gets our own product and Claude's
// original scene. Their words never go into ours: the planners only get the breakdown,
// written in our voice, and the same no-offers, no-other-brands rules as the builders.
//
// **Spend is capped**: at most MAX_MOCKUPS paid images per batch, checked when it starts.
//
// The batch lives in creative_batches. A worker (`runBatch`) holds a lease on it, does as
// many steps as fit in its time budget (mockups three at a time), then hands on to a fresh
// invocation of /api/recreate/worker. If a worker dies, the next look at the batch (the
// Inspiration or Drafts tab polling, or the ingest cron) finds the lease expired and starts
// another, so a batch never just stops.
import sharp from 'sharp';
import Anthropic from '@anthropic-ai/sdk';
import { dbQuery, listBrandAssets, getVoiceRow } from './db.js';
import { BRANDS, brandVoice as fallbackVoice } from './brands.js';
import { getAd, getCapture, analyzeAd } from './inspiration.js';
import { listActiveProducts } from './shopify.js';
import { printifyMockupIndex, mockupsFor } from './printifyMockups.js';
import { generateMockup, variationsFor, suggestScene } from './mockups.js';
import { planVideos } from './adVideo.js';
import { planStills } from './stillPlan.js';
import { adNotesFor } from './adcopy.js';
import { saveDraft, saveMockupDraft } from './drafts.js';
import { startRender } from './serverRender.js';
import { checkMockup } from './mockupCheck.js';
import { whatWorked } from './adResults.js';
import { ACCENTS } from './adPlans.js';
import { stripDashes } from './classify.js';
import { postBatchDone } from './notify.js';
import { batchSpend } from './spend.js';

export const MAX_MOCKUPS = 20;      // paid images per batch: the spending guard
export const MAX_ITEMS = 10;        // ads per batch
export const MAX_PER_AD = 4;        // mockups per ad
export const MAX_RETRIES = 5;       // extra images a batch may spend redoing shots that failed the check
const AT_ONCE = 3;                  // mockups generated in parallel
const LEASE_MS = 12 * 60 * 1000;    // a worker this quiet for this long is presumed dead
const BUDGET_MS = 560 * 1000;       // work per invocation, inside the route's 800s
const SLOWEST_STEP_MS = 230 * 1000; // a mockup can take this long; no new step starts later
const PICK_MODEL = process.env.CLASSIFY_MODEL || 'claude-haiku-4-5-20251001';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const shape = (r) => ({
  id: r.id, brand: r.brand, status: r.status, options: r.options || {}, items: r.items || [],
  by: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  leaseUntil: r.lease_until,
});

export async function getBatch(id) {
  const { rows } = await dbQuery('SELECT * FROM creative_batches WHERE id = $1', [Number(id)]);
  return rows[0] ? shape(rows[0]) : null;
}

export async function listBatches({ limit = 10 } = {}) {
  const { rows } = await dbQuery('SELECT * FROM creative_batches ORDER BY created_at DESC LIMIT $1', [limit]);
  return rows.map(shape);
}

async function saveItems(id, items, status) {
  await dbQuery(
    `UPDATE creative_batches SET items = $2, status = COALESCE($3, status), updated_at = now() WHERE id = $1`,
    [Number(id), JSON.stringify(items), status || null]);
}

// ---- starting ---------------------------------------------------------------------------

/**
 * Creates a batch. `picks`: [{ type: 'ad' | 'capture', id }]. `make`: auto (Claude's pick
 * per ad), image or video. `perAd`: mockups per ad. `aspect`: '9:16' | '4:5' | '1:1' or
 * '' for each kind's own default. Refuses anything over the spend cap.
 */
export async function createBatch({ brand, picks, make = 'auto', perAd = 2, aspect = '', notes = '', by, origin }) {
  if (!BRANDS[brand]) throw new Error('Pick one of our stores.');
  // Ad ids are Meta's 16-digit ids, kept as strings (they do not fit a JS number exactly).
  const list = (Array.isArray(picks) ? picks : []).filter((p) => p && ['ad', 'capture'].includes(p.type) && /^\d{1,25}$/.test(String(p.id)))
    .map((p) => ({ type: p.type, id: String(p.id) }));
  const unique = [...new Map(list.map((p) => [p.type + p.id, p])).values()];
  if (!unique.length) throw new Error('Pick at least one ad.');
  if (unique.length > MAX_ITEMS) throw new Error('One batch takes up to ' + MAX_ITEMS + ' ads.');
  const per = Math.max(1, Math.min(MAX_PER_AD, Math.round(Number(perAd) || 1)));
  if (unique.length * per > MAX_MOCKUPS) throw new Error('That is ' + unique.length * per + ' mockups; a batch makes at most ' + MAX_MOCKUPS + '.');
  const items = [];
  for (const p of unique) {
    const row = p.type === 'ad' ? await getAd(p.id) : await getCapture(p.id);
    if (!row) continue;
    items.push({
      key: p.type + p.id, source: { type: p.type, id: p.id, competitor: row.competitor || '' },
      label: (row.competitor || 'Capture') + (p.type === 'ad' && row.headline ? ': ' + String(row.headline).slice(0, 80) : ''),
      stage: 'analyze', mockups: [], products: [], error: '',
    });
  }
  if (!items.length) throw new Error('Those ads are no longer in Backstage.');
  const options = {
    make: ['auto', 'image', 'video'].includes(make) ? make : 'auto', perAd: per,
    aspect: ['9:16', '4:5', '1:1'].includes(aspect) ? aspect : '', notes: String(notes || '').slice(0, 600),
    origin: /^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : null,
  };
  const { rows } = await dbQuery(
    `INSERT INTO creative_batches (brand, status, options, items, created_by) VALUES ($1, 'running', $2, $3, $4) RETURNING *`,
    [brand, JSON.stringify(options), JSON.stringify(items), by || null]);
  return shape(rows[0]);
}

/**
 * A batch of mockups only, no ad: `products` [{ productId, color? }] from the store, with
 * one written `scene` for all of them, or a scene per product written by Claude inside
 * `theme` (a place, "a basement show") or the brand's own direction when neither is given.
 * Used by the creative MCP connection. Same spend cap as any batch.
 */
export async function createMockupBatch({ brand, products, scene = '', theme = '', perProduct = 1, by, origin }) {
  if (!BRANDS[brand]) throw new Error('Pick one of our stores.');
  const want = (Array.isArray(products) ? products : []).filter((p) => p && p.productId);
  if (!want.length) throw new Error('Name at least one product (its id from search_products).');
  const per = Math.max(1, Math.min(MAX_PER_AD, Math.round(Number(perProduct) || 1)));
  if (want.length * per > MAX_MOCKUPS) throw new Error('That is ' + want.length * per + ' mockups; a batch makes at most ' + MAX_MOCKUPS + '.');
  const all = await storeProducts(brand, {});
  const chosen = want.map((w) => {
    const p = all.find((x) => x.id === w.productId || x.handle === w.productId);
    if (!p) throw new Error('No active product ' + w.productId + ' in ' + BRANDS[brand].name + '.');
    const c = w.color && p.colors.find((x) => x.name.toLowerCase() === String(w.color).toLowerCase());
    if (w.color && !c) throw new Error(p.title + ' does not come in ' + w.color + '. It comes in: ' + p.colors.map((x) => x.name).join(', ') + '.');
    const { colors, ...base } = p;
    return c ? { ...base, image: c.front, color: c.name } : base;
  });
  const flat = chosen.flatMap((p) => Array.from({ length: per }, () => p));
  const variations = variationsFor(brand, flat.length);
  const fixed = String(scene || '').trim().slice(0, 1500);
  const item = {
    key: 'products', source: { type: 'products' }, planless: true, theme: String(theme || '').trim().slice(0, 300),
    label: 'Mockups: ' + chosen.map((p) => p.title).slice(0, 3).join(', ') + (chosen.length > 3 ? ' and ' + (chosen.length - 3) + ' more' : ''),
    stage: 'mockups', make: null, recipe: { scene: '', hook: '', product: '', headlines: [] }, error: '',
    products: chosen.filter((p, i, a) => a.findIndex((x) => x.id === p.id && x.color === p.color) === i),
    mockups: flat.map((p, i) => ({ productId: p.id, color: p.color, image: p.image, variationIndex: i, variation: variations[i], ...(fixed ? { scene: fixed, fixedScene: fixed } : {}) })),
  };
  const options = { make: 'none', perAd: per, aspect: '', notes: '', origin: /^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : null };
  const { rows } = await dbQuery(
    `INSERT INTO creative_batches (brand, status, options, items, created_by) VALUES ($1, 'running', $2, $3, $4) RETURNING *`,
    [brand, JSON.stringify(options), JSON.stringify([item]), by || null]);
  return shape(rows[0]);
}

// ---- from our own brief ------------------------------------------------------------------

const BRIEF_MODEL = process.env.DRAFT_MODEL || 'claude-sonnet-4-6';
const ANGLES_TOOL = {
  name: 'angles',
  description: 'Distinct ad angles for the brief.',
  input_schema: {
    type: 'object',
    properties: {
      angles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hook: { type: 'string', description: 'The angle in one sentence.' },
            tool: { type: 'string', enum: ['image', 'video'], description: 'Which suits this angle better.' },
            product: { type: 'string', description: 'What kind of our product to show, as a short description.' },
            headlines: { type: 'array', items: { type: 'string' }, description: '2 or 3 headline ideas in our voice.' },
            scene: { type: 'string', description: 'A lifestyle scene brief for the mockups, 2 to 3 sentences: setting, person, moment, light. Never the artwork.' },
          },
          required: ['hook', 'tool', 'product', 'headlines', 'scene'],
        },
      },
    },
    required: ['angles'],
  },
};

/** `count` genuinely different angles on one brief, each shaped like an ad breakdown. */
async function briefAngles(brand, brief, count) {
  const voice = (await getVoiceRow(brand)) || fallbackVoice(brand);
  const res = await anthropic.messages.create({
    model: BRIEF_MODEL, max_tokens: 2500, tools: [ANGLES_TOOL],
    system: voice + '\n\nYou are a creative strategist planning paid social ads for this brand.',
    messages: [{ role: 'user', content: [
      'Plan ' + count + ' genuinely different ad angles for ' + BRANDS[brand].name + ' from this brief:', '', String(brief).slice(0, 2000), '',
      'Rules:',
      '- Different hooks, settings and moods across the angles, not rewordings of one idea.',
      '- Headlines in our voice. Never invent offers, discounts, prices, shipping promises or giveaways unless the brief states them.',
      '- Never name a band, artist, show, film or any company or brand other than ours.',
      brand === 'wallspoke' ? '- It is wall art: scenes describe the room it hangs in.' : '- It is apparel: scenes describe who wears it, where, the moment and the light.',
      '- No em dashes or en dashes.',
      'Answer with the angles tool.',
    ].join('\n') }],
  });
  const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'angles');
  const list = (call && call.input && Array.isArray(call.input.angles)) ? call.input.angles : [];
  const t = (v, n) => stripDashes(String(v || '')).trim().slice(0, n);
  return list.slice(0, count).map((a) => ({
    format: '', hook: t(a.hook, 300), why: '', tool: a.tool === 'video' ? 'video' : 'image', toolWhy: '', steps: [],
    product: t(a.product, 80), headlines: (Array.isArray(a.headlines) ? a.headlines : []).map((h) => t(h, 120)).filter(Boolean).slice(0, 3),
    scene: t(a.scene, 900), avoid: '',
  }));
}

/**
 * A batch from our own idea rather than a competitor's ad: Claude turns `brief` into
 * `count` angles, and each goes through the same products, mockups, plan and render as a
 * recreated ad. Same spend cap.
 */
export async function createBriefBatch({ brand, brief, count = 3, make = 'auto', perAd = 2, aspect = '', by, origin }) {
  if (!BRANDS[brand]) throw new Error('Pick one of our stores.');
  if (String(brief || '').trim().length < 8) throw new Error('Say what the ads are for: a product, a drop, a mood.');
  const n = Math.max(1, Math.min(MAX_ITEMS, Math.round(Number(count) || 1)));
  const per = Math.max(1, Math.min(MAX_PER_AD, Math.round(Number(perAd) || 1)));
  if (n * per > MAX_MOCKUPS) throw new Error('That is ' + n * per + ' mockups; a batch makes at most ' + MAX_MOCKUPS + '.');
  const angles = await briefAngles(brand, brief, n);
  if (!angles.length) throw new Error('Claude did not come back with angles. Try again.');
  const mk = ['image', 'video'].includes(make) ? make : null;
  const items = angles.map((r, i) => ({
    key: 'brief' + (i + 1), source: { type: 'brief', brief: String(brief).slice(0, 300) }, label: 'Idea ' + (i + 1) + ': ' + r.hook.slice(0, 90),
    stage: 'products', recipe: r, make: mk || r.tool, mockups: [], products: [], error: '',
  }));
  const options = {
    make: mk || 'auto', perAd: per, aspect: ['9:16', '4:5', '1:1'].includes(aspect) ? aspect : '', notes: 'The brief: ' + String(brief).slice(0, 500),
    origin: /^https?:\/\/[^/]+$/.test(String(origin || '')) ? origin : null,
  };
  const { rows } = await dbQuery(
    `INSERT INTO creative_batches (brand, status, options, items, created_by) VALUES ($1, 'running', $2, $3, $4) RETURNING *`,
    [brand, JSON.stringify(options), JSON.stringify(items), by || null]);
  return shape(rows[0]);
}

export async function stopBatch(id) {
  await dbQuery(`UPDATE creative_batches SET status = 'stopped', lease_until = NULL, updated_at = now() WHERE id = $1 AND status = 'running'`, [Number(id)]);
}

// ---- the worker -------------------------------------------------------------------------

// Takes the batch for this worker if nobody else holds it. Returns false if someone does.
async function lease(id) {
  const { rows } = await dbQuery(
    `UPDATE creative_batches SET lease_until = now() + ($2 || ' milliseconds')::interval
      WHERE id = $1 AND status = 'running' AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
    [Number(id), String(LEASE_MS)]);
  return rows.length > 0;
}
const renew = (id) => dbQuery(`UPDATE creative_batches SET lease_until = now() + ($2 || ' milliseconds')::interval WHERE id = $1`, [Number(id), String(LEASE_MS)]);
const release = (id) => dbQuery('UPDATE creative_batches SET lease_until = NULL WHERE id = $1', [Number(id)]);

/** Running batches nobody is working on (lease expired or never taken). */
export async function idleBatches() {
  const { rows } = await dbQuery(
    `SELECT id FROM creative_batches WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now()) ORDER BY id LIMIT 5`);
  return rows.map((r) => r.id);
}

/**
 * Works on a batch until it is done or the time budget is used. Returns 'done', 'more'
 * (call again) or 'busy' (another worker has it).
 */
export async function runBatch(id) {
  if (!(await lease(id))) return 'busy';
  const started = Date.now();
  let batch = await getBatch(id);
  const ctx = { products: null, kit: null, standing: null };
  try {
    while (batch && batch.status === 'running') {
      if (Date.now() - started > BUDGET_MS - SLOWEST_STEP_MS) return 'more';
      const units = nextUnits(batch);
      if (!units.length) {
        const status = batch.items.every((it) => it.stage === 'failed') ? 'failed' : 'done';
        await saveItems(id, batch.items, status);
        // Slack, so a batch started from a phone says when it is ready (lib/notify.js).
        const spent = (await batchSpend([batch.id]).catch(() => ({})))[batch.id];
        await postBatchDone({ brand: batch.brand, items: batch.items, status, cost: spent ? spent.cost : 0 }).catch(() => {});
        return 'done';
      }
      // Steps run side by side but write one at a time, against the latest batch row, so a
      // stop pressed meanwhile is respected and nothing is overwritten.
      let chain = Promise.resolve();
      await Promise.all(units.map((u) => doUnit(batch, u, ctx).then(
        (apply) => { chain = chain.then(() => commit(id, u.key, apply)); return chain; },
        (err) => { chain = chain.then(() => commit(id, u.key, (it) => fail(it, u, err))); return chain; },
      )));
      await chain;
      await renew(id);
      batch = await getBatch(id);
    }
    return 'done';
  } finally {
    await release(id).catch(() => {});
  }
}

async function commit(id, key, apply) {
  const cur = await getBatch(id);
  if (!cur) return;
  const items = cur.items.map((it) => (it.key === key ? apply(it) : it));
  await saveItems(id, items);
}

// A failed mockup is retried once, then skipped; the ad goes ahead with what it has. Any
// other failed step fails that ad only.
function fail(it, u, err) {
  const message = String((err && err.message) || err).slice(0, 400);
  if (u.step === 'mockup') {
    const mockups = it.mockups.map((m, i) => (i === u.index ? { ...m, tries: (m.tries || 0) + 1, error: message } : m));
    return { ...it, mockups };
  }
  return { ...it, stage: 'failed', error: message };
}

// What can run now: every item's next step, with up to AT_ONCE mockups across the batch.
function nextUnits(batch) {
  const out = [];
  let mockups = 0;
  for (const it of batch.items) {
    if (it.stage === 'mockups') {
      it.mockups.forEach((m, i) => {
        if (!m.draftId && (m.tries || 0) < 2 && mockups < AT_ONCE) { out.push({ key: it.key, step: 'mockup', index: i }); mockups++; }
      });
      const settled = it.mockups.every((m) => m.draftId || (m.tries || 0) >= 2);
      if (settled) out.push({ key: it.key, step: it.planless ? 'finish' : 'plan' });
    } else if (['analyze', 'products', 'plan', 'render'].includes(it.stage)) {
      out.push({ key: it.key, step: it.stage });
    }
  }
  // The mockup steps first, so the slow ones start as early as possible; at most a
  // handful of quick steps beside them.
  out.sort((a, b) => (a.step === 'mockup' ? 0 : 1) - (b.step === 'mockup' ? 0 : 1));
  return out.slice(0, AT_ONCE + 3);
}

// Does one step and returns how to apply its result to the item.
async function doUnit(batch, u, ctx) {
  const it = batch.items.find((x) => x.key === u.key);
  const brand = batch.brand;
  if (u.step === 'analyze') {
    const recipe = await analyzeItem(brand, it);
    const make = batch.options.make === 'auto' ? (recipe.tool === 'video' ? 'video' : 'image') : batch.options.make;
    return (x) => ({ ...x, recipe, make, stage: 'products' });
  }
  if (u.step === 'products') {
    const used = new Set(batch.items.flatMap((x) => (x.products || []).map((p) => p.id)));
    const products = await pickProducts(brand, it.recipe, batch.options.perAd, used, ctx);
    if (!products.length) throw new Error('No products in the store to use.');
    const variations = variationsFor(brand, products.length);
    return (x) => ({
      ...x, products, stage: 'mockups',
      mockups: products.map((p, i) => ({ productId: p.id, variationIndex: i, variation: variations[i] })),
    });
  }
  if (u.step === 'mockup') {
    const m = it.mockups[u.index];
    const found = it.products.find((x) => x.id === m.productId && (!m.color || x.color === m.color)) || it.products.find((x) => x.id === m.productId);
    const p = m.image ? { ...found, image: m.image, color: m.color || found.color } : found;
    // Claude's brief describes the competitor's kind of product (it once dressed a hoodie
    // in "relaxed-fit bottoms"), so each product gets its own scene, written looking at it,
    // kept in the brief's setting and different from the item's other shots.
    const setting = it.theme || String(it.recipe.scene || '').split(/(?<=[.!?])\s+/)[0].slice(0, 300);
    const scene = m.fixedScene || m.scene || await suggestScene({
      brand, product: { title: p.title, productType: p.productType, image: p.image }, theme: setting,
      previous: it.mockups.map((x) => x.scene).filter(Boolean),
    }).catch(() => it.recipe.scene);
    const result = await generateMockup({ brand, imageUrl: p.image, scene, variation: m.variation, spend: { batchId: batch.id, by: batch.by } });
    // (p.image is the colour picked for this product, when one was.)
    // Checked against the flat mockup before it can go into an ad (lib/mockupCheck.js).
    const check = await checkMockup({ source: p.image, result: result.b64 });
    const draft = await saveMockupDraft({
      brand, product: p, b64: result.b64, sourceImage: p.image, scene, result, by: batch.by,
      extra: { batchId: batch.id, check, ...(['ad', 'capture'].includes(it.source.type) ? { inspiration: it.source } : {}) },
    });
    const [w, h] = String(result.size || '1024x1536').split('x').map(Number);
    // A shot that fails the check is done again once, while the batch's retry allowance
    // lasts; the failed one stays in Drafts, flagged. A second try is kept whatever it scores.
    const retriesUsed = batch.items.reduce((n, x) => n + x.mockups.filter((mm) => mm.retried).length, 0);
    const retry = check && !check.pass && !m.retried && retriesUsed < MAX_RETRIES;
    return (x) => ({
      ...x, mockups: x.mockups.map((mm, i) => (i !== u.index ? mm : retry
        ? { ...mm, scene: undefined, retried: true, rejected: [...(mm.rejected || []), { draftId: draft.id, url: draft.output.url, check }] }
        : { ...mm, scene, draftId: draft.id, url: draft.output.url, width: w, height: h, check, error: '' })),
    });
  }
  if (u.step === 'finish') {
    const made = it.mockups.filter((m) => m.draftId).length;
    return (x) => (made ? { ...x, stage: 'done' } : { ...x, stage: 'failed', error: 'None of the mockups came out.' });
  }
  if (u.step === 'plan') {
    const draft = await planItem(batch, it, ctx);
    return (x) => ({ ...x, draftId: draft.id, stage: 'render' });
  }
  if (u.step === 'render') {
    const { run } = await startRender({ draftId: it.draftId, accent: ACCENTS[brand], by: batch.by });
    await run();
    return (x) => ({ ...x, stage: 'done' });
  }
  throw new Error('Unknown step ' + u.step);
}

// ---- the steps --------------------------------------------------------------------------

async function analyzeItem(brand, it) {
  const brandName = BRANDS[brand].name;
  if (it.source.type === 'capture') {
    const c = await getCapture(it.source.id);
    if (!c) throw new Error('That capture is gone.');
    const info = c.read_info || c.info || {};
    const ad = {
      competitor: c.competitor || 'an advertiser seen on a phone', headline: info.headline || '', text: info.text || '',
      active: true, ourNote: c.note, format: c.kind === 'video' ? 'VIDEO' : 'IMAGE',
    };
    // A recording has no frame on the server, so it is judged from what was read off it.
    return analyzeAd({ ad, brand, brandName, imageUrls: c.kind === 'image' ? [c.url] : [] });
  }
  const a = await getAd(it.source.id);
  if (!a) throw new Error('That ad is no longer in Backstage.');
  const media = a.media || [];
  const imageUrls = media.filter((m) => m.kind === 'image').map((m) => m.url);
  const v = media.find((m) => m.kind === 'video' && m.poster);
  if (v) imageUrls.unshift(v.poster);
  return analyzeAd({
    brand, brandName, imageUrls,
    ad: {
      competitor: a.competitor, headline: a.headline, text: a.body, format: a.display_format, active: a.active,
      startDate: a.start_date ? new Date(a.start_date).toISOString().slice(0, 10) : '',
      days: a.start_date ? Math.round((Date.now() - new Date(a.start_date)) / 86400000) : 0,
      rank: a.impression_rank, copies: a.collation_count || 1, ourNote: a.notes,
    },
  });
}

// The store's products, once per worker run, each with the picture to generate from: the
// original Printify mockup in its default colour where there is one.
async function storeProducts(brand, ctx) {
  if (ctx.products) return ctx.products;
  const [products, index] = await Promise.all([
    listActiveProducts(brand),
    printifyMockupIndex(brand, { staleOk: true }).catch(() => null),
  ]);
  const all = products.map((p) => {
    const m = mockupsFor(index, p.skus);
    const def = m && (m.colors.find((c) => c.name === m.defaultColor) || m.colors[0]);
    return {
      id: p.id, handle: p.handle, title: p.title, productType: p.productType || '', image: def ? def.front : p.image, color: def ? def.name : null,
      printify: Boolean(def), colors: m ? m.colors.map((c) => ({ name: c.name, front: c.front })) : [],
    };
  }).filter((p) => p.image);
  // On a Printify store only Printify items are offered: the rest are bundles and resold
  // goods (a Loog guitar bundle was picked once), with no flat mockup to put in a scene.
  const printified = all.filter((p) => p.printify);
  ctx.products = (printified.length ? printified : all).map(({ printify, ...p }) => p);
  return ctx.products;
}

// One listing per design: the per-market copies (titled "... (UK)", "... CA") are the same
// product to look at, so only the first, the US one, is offered.
const baseTitle = (t) => String(t || '').replace(/\s*\(?\b(US|UK|CA|AU|EU)\b\)?\s*$/i, '').trim().toLowerCase();

const KIDS = /\b(toddler|infant|baby|babies|onesie|bodysuit|kids?|youth|children|child)\b/i;

const PICK_TOOL = {
  name: 'pick',
  description: 'The products to photograph for this ad, best first.',
  input_schema: {
    type: 'object',
    properties: { numbers: { type: 'array', items: { type: 'integer' }, description: 'Line numbers from the product list.' } },
    required: ['numbers'],
  },
};

// Claude picks from the real catalog: a keyword match on its search term once matched
// "relaxed fit pants" to an onesie called Underpants, for a store that sells no pants.
// Products another ad in the batch already uses are marked, so ten ads do not all show the
// same shirt. If Claude fails, the newest products stand in (the list is newest first).
export async function pickProducts(brand, recipe, n, used, ctx) {
  const all = await storeProducts(brand, ctx);
  const seen = new Set();
  // Kids' garments only when the idea is about kids (Claude picked a toddler tee for an
  // adult idea even when told not to), and never something that cannot be photographed.
  const kidsIdea = KIDS.test(recipe.hook + ' ' + recipe.product);
  const list = all
    .filter((p) => !/gift ?card/i.test(p.title + ' ' + p.productType))
    .filter((p) => kidsIdea || !KIDS.test(p.title + ' ' + p.productType))
    .filter((p) => { const k = baseTitle(p.title); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 400);
  const strip = ({ colors, ...p }) => p;
  try {
    const lines = list.map((p, i) => (i + 1) + '. ' + p.title + (p.productType ? ' [' + p.productType + ']' : '') + (used.has(p.id) ? ' (already used)' : ''));
    const res = await anthropic.messages.create({
      model: PICK_MODEL, max_tokens: 300, tools: [PICK_TOOL],
      messages: [{ role: 'user', content: [
        'We are making our own ad for ' + BRANDS[brand].name + ', inspired by an idea in a competitor ad. Pick the ' + n +
          ' products from our store below that would make the strongest ad for this idea. They are photographed being worn or used.',
        'The idea: ' + recipe.hook,
        'What the ad would show: ' + recipe.product,
        'If nothing in our store is that kind of product, pick our closest equivalents (for example our best looking tees or hoodies) rather than an odd match on a word.',
        'Prefer adult products unless the idea is about kids, and different designs rather than one design twice. Avoid ones marked already used unless nothing else fits.',
        '', 'Our products (newest first):', ...lines, '', 'Answer with the pick tool.',
      ].join('\n') }],
    });
    const call = res.content.find((c) => c.type === 'tool_use' && c.name === 'pick');
    let nums = call && Array.isArray(call.input.numbers) ? call.input.numbers : null;
    if (!nums) {
      const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      nums = (text.match(/\d+/g) || []).map(Number);
    }
    const picked = [...new Set(nums)].map((k) => list[k - 1]).filter(Boolean).slice(0, n);
    // A short answer is topped up from the newest unused products, so a batch makes the
    // number of mockups it was asked for.
    if (picked.length) {
      for (const p of [...list.filter((x) => !used.has(x.id)), ...list]) { if (picked.length >= n) break; if (!picked.includes(p)) picked.push(p); }
      return picked.map(strip);
    }
  } catch (err) {
    console.error('[recreate] product pick', err.message);
  }
  return [...list.filter((p) => !used.has(p.id)), ...list.filter((p) => used.has(p.id))].slice(0, n).map(strip);
}

// The brand kit as the planners see it: logos, end cards and approved songs, with the ids
// the renderer uses ('k' + id).
async function kitFor(brand, ctx) {
  if (ctx.kit) return ctx.kit;
  const rows = await listBrandAssets(brand);
  ctx.kit = rows.filter((a) => a.kind !== 'font').map((a) => {
    const meta = a.meta || {};
    const base = { id: 'k' + a.id, name: a.name, title: '', origin: 'kit', ...meta };
    return a.kind === 'music'
      ? { ...base, kind: 'audio', approved: true, beat: meta.bpm ? { bpm: meta.bpm, period: meta.period, offset: meta.offset } : null }
      : { ...base, kind: a.kind };
  });
  return ctx.kit;
}

async function thumbOf(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await sharp(Buffer.from(await res.arrayBuffer())).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
  return { mediaType: 'image/jpeg', data: buf.toString('base64') };
}

// Plans one ad from the item's mockups and the brand kit with the builders' own planners,
// and saves it as a draft the builders can open.
async function planItem(batch, it, ctx) {
  // Shots that passed the check (or could not be checked) first; a failed one only when
  // nothing better came out.
  const made = it.mockups.filter((m) => m.draftId);
  const good = made.filter((m) => !m.check || m.check.pass);
  const shots = (good.length ? good : made).map((m) => {
    const p = it.products.find((x) => x.id === m.productId) || {};
    return { url: m.url, title: p.title || '', handle: p.handle || '', width: m.width, height: m.height, draftId: m.draftId };
  });
  if (!shots.length) throw new Error('None of the mockups came out, so there is nothing to build the ad from.');
  const r = it.recipe;
  // The breakdown only, in our words: never their headline or text.
  const notes = [
    it.source.type === 'brief' ? 'This ad is one angle on our own brief.' : 'This ad is our own take on an idea seen in a competitor ad. Do not reproduce that ad; use the idea.',
    'The idea: ' + r.hook,
    r.why ? 'Why it works: ' + r.why : '',
    r.headlines.length ? 'Headline ideas in our voice (use or improve): ' + r.headlines.join(' | ') : '',
    r.avoid ? 'Avoid: ' + r.avoid : '',
    batch.options.notes ? 'From us: ' + batch.options.notes : '',
  ].filter(Boolean).join('\n');
  return planAd({
    brand: batch.brand, kind: it.make, shots, notes, aspect: batch.options.aspect, by: batch.by, ctx,
    source: { madeWith: it.source.type === 'brief' ? 'brief' : 'inspiration', batchId: batch.id, ...(it.source.type === 'brief' ? { brief: it.source.brief } : { inspiration: it.source }), hook: r.hook },
  });
}

/**
 * One video or image ad planned by Claude from `shots` (stored mockups: url, title, handle,
 * width, height, draftId) plus the brand kit, saved as a draft. Used by batches and by the
 * creative MCP connection's build_ad.
 */
export async function planAd({ brand, kind, shots, notes = '', aspect = '', by, source = {}, ctx = { products: null, kit: null, standing: null } }) {
  if (!['video', 'image'].includes(kind)) throw new Error('An ad is a video or an image.');
  const pics = await Promise.all(shots.map(async (m, i) => ({
    id: 'm' + (i + 1), kind: 'image', url: m.url, name: (m.handle || 'mockup') + '.png', title: m.title || '', handle: m.handle || '',
    width: m.width || 1024, height: m.height || 1536, origin: 'mockup', draftId: m.draftId || null, thumb: await thumbOf(m.url).catch(() => null),
  })));
  const kit = await kitFor(brand, ctx);
  if (ctx.standing === null || ctx.standing === undefined) {
    // Standing notes for the store, plus what its own past ads earned (lib/adResults.js).
    const [standing, learned] = await Promise.all([adNotesFor(brand).catch(() => ''), whatWorked(brand).catch(() => '')]);
    ctx.standing = [standing, learned].filter(Boolean).join('\n\n');
  }
  const assets = [...pics, ...kit];
  const brandName = BRANDS[brand].name;
  const song = kit.find((a) => a.kind === 'audio' && a.beat);
  const plan = kind === 'video'
    ? (await planVideos({ brand, brandName, assets, aspect: aspect || '9:16', notes, standing: ctx.standing,
        beat: song ? { asset: song.id, ...song.beat } : null, count: 1 }))[0]
    : (await planStills({ brand, brandName, assets, aspect: aspect || '4:5', notes, standing: ctx.standing, count: 1 }))[0];
  const stored = pics.map(({ thumb, ...a }) => a);
  return saveDraft({ brand, kind, title: plan.title, plan, assets: stored, by, source });
}

// ---- keeping it moving ------------------------------------------------------------------

const WORKER_PATH = '/api/recreate/worker';

/** Starts a fresh worker invocation for a batch. Returns once the request is on its way. */
export async function kickWorker(batch) {
  const origin = (batch.options && batch.options.origin)
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : null);
  if (!origin || !process.env.INGEST_SECRET) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(origin + WORKER_PATH, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-worker-key': process.env.INGEST_SECRET },
      body: JSON.stringify({ id: batch.id }),
    });
  } catch { /* an abort after sending is expected: the worker answers once it has started */ } finally {
    clearTimeout(t);
  }
  return true;
}

/** Works on a batch, then hands on to a fresh invocation if there is more to do. */
export async function driveBatch(id) {
  const r = await runBatch(id);
  if (r === 'more') {
    const b = await getBatch(id);
    if (b && b.status === 'running') await kickWorker(b);
  }
  return r;
}

/** Restarts batches whose worker has gone quiet; the tabs' polling and the ingest cron call it. */
export async function wakeIdleBatches() {
  const ids = await idleBatches();
  for (const id of ids) {
    const b = await getBatch(id);
    if (b) await kickWorker(b);
  }
  return ids.length;
}
