// Renders video and image drafts on Vercel Sandbox (@remotion/vercel), so an ad can be
// started from a phone and picked up later on any device. The browser builders still
// render on the device too; this is the path that does not need the tab to stay open.
//
// How a render runs:
//   1. The builder saves the draft first (pictures copied to Blob), then asks for a render.
//      Everything the render needs is rebuilt here from the saved draft, the brand kit and
//      the brand style, so the server never trusts a plan or a URL from the client.
//   2. A sandbox is restored from a snapshot that already has Chrome, the renderer and the
//      fonts (made once per Remotion version, `ensureSnapshot`), and gets this deploy's
//      bundle of the templates (.remotion/, scripts/bundle-remotion.mjs).
//   3. A video renders detached: the sandbox renders and uploads to Blob at a path we chose,
//      and nobody has to wait on it. An image is quick, so it renders and uploads in the
//      request's after().
//   4. `checkRender` turns a finished job into the draft's output. It runs whenever the
//      builder or the Drafts tab polls, and from the ingest cron, so a render started from
//      a phone that was then closed still lands. If the sandbox has already gone, the file
//      at the chosen Blob path is the proof it finished.
//
// The job lives in the draft's own `output.job`, so there is no table to keep in step: an
// earlier output stays in place (url and all) until the new file replaces it.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { head } from '@vercel/blob';
import {
  createSandbox, addBundleToSandbox, renderMediaOnVercel, renderStillOnVercel, uploadToVercelBlob, getRenderProgress,
} from '@remotion/vercel';
import { VERSION } from 'remotion/version';
import { dbQuery, getSetting, deleteSetting, withSettingLock, listBrandAssets } from './db.js';
import { getDraft, saveDraft, DRAFT_PREFIX } from './drafts.js';
import { BRANDS } from './brands.js';
import { cleanStyle, styleKey } from './brandStyle.js';
import { ASPECTS, FPS, normalizePlan, timeline } from './adPlans.js';
import { normalizeStill } from './stillPlans.js';
import { recordSpend, renderCost } from './spend.js';

const SNAPSHOT_KEY = 'render_snapshot_' + VERSION;  // a new Remotion version makes a new one
const BUNDLE_DIR = path.join(process.cwd(), '.remotion');
const VCPUS = 4;
// A job that has not started rendering after this long, or an image after this long, failed.
const START_LIMIT_MS = 8 * 60 * 1000;
// A detached video sandbox keeps itself alive this long at most; checkRender stops it as
// soon as the file is in, so this only bounds a render nobody ever checks on.
const DETACHED_LIMIT_MS = 20 * 60 * 1000;
// Fonts the templates name that a Linux sandbox lacks: Arial, Helvetica and Times have
// metric-compatible Liberation faces (fontconfig maps the names), emoji need Noto.
const EXTRA_FONTS = ['liberation-sans-fonts', 'liberation-serif-fonts', 'google-noto-emoji-color-fonts'];

const blobToken = () => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error('Rendering needs the Blob store (BLOB_READ_WRITE_TOKEN).');
  return process.env.BLOB_READ_WRITE_TOKEN;
};
const licenseKey = () => process.env.REMOTION_LICENSE_KEY || process.env.NEXT_PUBLIC_REMOTION_LICENSE_KEY || null;
const plainUrl = (u) => String(u || '').split('?')[0];

// ---- the sandbox ------------------------------------------------------------------------

/**
 * The id of a snapshot with Chrome, the renderer and the fonts installed. Made the first
 * time it is needed (a few minutes), under a lock so two renders never build two.
 */
export async function ensureSnapshot(onStage = () => {}) {
  const have = await getSetting(SNAPSHOT_KEY);
  if (have) return JSON.parse(have).snapshotId;
  return withSettingLock(SNAPSHOT_KEY, async (cur) => {
    if (cur) return { result: JSON.parse(cur).snapshotId };
    onStage('preparing');
    const sandbox = await createSandbox({ resources: { vcpus: VCPUS } });
    try {
      // One package at a time, so one the distribution lacks does not stop the others.
      const fonts = await sandbox.runCommand({ cmd: 'sh', args: ['-c', EXTRA_FONTS.map((f) => 'sudo dnf install -y ' + f + ' || echo "missing ' + f + '"').join('; ') + '; fc-list | wc -l'] });
      console.log('Render snapshot fonts: ' + (await fonts.stdout()).split('\n').filter((l) => /missing|^\d+$/.test(l.trim())).join(', '));
      const snap = await sandbox.snapshot({ expiration: 0 });
      return { value: JSON.stringify({ snapshotId: snap.snapshotId, version: VERSION, at: new Date().toISOString() }), result: snap.snapshotId };
    } catch (err) {
      await sandbox.stop().catch(() => {});
      throw err;
    }
  });
}

// A fresh sandbox from the snapshot with this deploy's templates in it. A snapshot that
// has gone missing is forgotten and rebuilt once.
async function openSandbox(onStage) {
  let snapshotId = await ensureSnapshot(onStage);
  let sandbox;
  try {
    sandbox = await Sandbox.create({ source: { type: 'snapshot', snapshotId }, resources: { vcpus: VCPUS }, timeout: 10 * 60 * 1000 });
  } catch (err) {
    if (!/not.?found|snapshot/i.test(String(err.message))) throw err;
    await deleteSetting(SNAPSHOT_KEY);
    snapshotId = await ensureSnapshot(onStage);
    sandbox = await Sandbox.create({ source: { type: 'snapshot', snapshotId }, resources: { vcpus: VCPUS }, timeout: 10 * 60 * 1000 });
  }
  try {
    await addBundleToSandbox({ sandbox, bundleDir: BUNDLE_DIR });
  } catch (err) {
    await sandbox.stop().catch(() => {});
    throw err;
  }
  return sandbox;
}

async function stopSandbox(sandboxId) {
  if (!sandboxId) return;
  try { await (await Sandbox.get({ sandboxId })).stop(); } catch { /* already gone */ }
}

// ---- what to render ---------------------------------------------------------------------

/**
 * The template props for a saved draft: its stored pictures, the brand kit (fonts to
 * load by URL), the brand style and the normalised plan, plus the frame size and length.
 */
export async function renderProps(draft, accent) {
  const [kitRows, rawStyle] = await Promise.all([listBrandAssets(draft.brand), getSetting(styleKey(draft.brand))]);
  let style = null;
  try { style = rawStyle ? cleanStyle(JSON.parse(rawStyle)) : null; } catch { style = null; }
  const kit = kitRows.map((a) => {
    const meta = a.meta || {};
    const base = { id: 'k' + a.id, name: a.name, title: '', origin: 'kit', kitId: a.id, ...meta, src: a.url };
    if (a.kind === 'music') return { ...base, kind: 'audio', beat: meta.bpm ? { bpm: meta.bpm, period: meta.period, offset: meta.offset } : null };
    if (a.kind === 'font') return { ...base, kind: 'font', family: 'bk-font-' + a.id };
    return { ...base, kind: a.kind };
  });
  const own = (draft.assets || []).filter((a) => a && a.url).map((a) => ({ ...a, src: a.url }));
  const all = [...own, ...kit];
  const plan = draft.kind === 'video' ? normalizePlan(draft.plan, all) : normalizeStill(draft.plan, all);
  if (!plan) throw new Error('This draft has nothing to render: its pictures are missing.');
  const dims = ASPECTS[plan.aspect] || ASPECTS['9:16'];
  const fonts = Object.fromEntries(kit.filter((a) => a.kind === 'font').map((a) => [a.id, a.family]));
  return {
    plan, assets: Object.fromEntries(all.map((a) => [a.id, a])), fonts, style,
    kitFonts: kit.filter((a) => a.kind === 'font').map((a) => ({ family: a.family, url: a.src })),
    brandName: (BRANDS[draft.brand] || {}).name || draft.brand,
    accent: /^#[0-9a-f]{3,8}$/i.test(String(accent || '')) ? accent : '#111827',
    width: dims.width, height: dims.height, fps: draft.kind === 'video' ? FPS : 30,
    frames: draft.kind === 'video' ? timeline(plan).total : 1,
  };
}

// ---- the job ----------------------------------------------------------------------------

const activeJob = (o) => o && o.job && !['failed'].includes(o.job.stage) ? o.job : null;
const jobExpired = (job) => Date.now() - new Date(job.startedAt).getTime() > START_LIMIT_MS;

// Writes `job` into the draft's output without touching anything else in it.
async function setJob(id, job) {
  await dbQuery(
    `UPDATE creative_drafts SET output = jsonb_set(CASE WHEN jsonb_typeof(output) = 'object' THEN output ELSE '{}'::jsonb END, '{job}', $2::jsonb)
      WHERE id = $1`, [Number(id), JSON.stringify(job)]);
}

async function failJob(draft, job, message) {
  await setJob(draft.id, { ...job, stage: 'failed', error: String(message || 'The render failed.').slice(0, 600), endedAt: new Date().toISOString() });
}

// The rendered file becomes the draft's output; the previous file is removed by saveDraft
// when no other draft uses it.
async function finishJob(draft, job, { url, size, contentType }) {
  await saveDraft({
    id: draft.id,
    output: {
      url: plainUrl(url), size: size || null, contentType: contentType || (job.kind === 'video' ? 'video/mp4' : 'image/jpeg'),
      width: job.width, height: job.height, renderedOn: 'server', at: new Date().toISOString(),
    },
  });
  await stopSandbox(job.sandboxId);
  const seconds = Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);
  await recordSpend({ kind: 'render', brand: draft.brand, draftId: draft.id, batchId: (draft.source && draft.source.batchId) || null, units: seconds, cost: renderCost(seconds), by: job.by });
}

/**
 * Queues a render of a saved video or image draft and returns the job at once; `run` is the
 * part to do after responding (Next's after()). Refuses while a render is already going.
 */
export async function startRender({ draftId, accent, by }) {
  const draft = await getDraft(draftId);
  if (!draft) throw new Error('That draft is gone.');
  if (!['video', 'image'].includes(draft.kind)) throw new Error('Only video and image drafts render.');
  const running = activeJob(draft.output);
  if (running && !jobExpired(running) && running.stage !== 'rendering') throw new Error('This draft is already rendering.');
  if (running && running.stage === 'rendering') {
    const now = await checkRender(draft);
    if (now && now.job && now.job.stage === 'rendering') throw new Error('This draft is already rendering.');
  }
  blobToken();
  const props = await renderProps(draft, accent);
  const ext = draft.kind === 'video' ? 'mp4' : 'jpg';
  const job = {
    id: randomUUID(), kind: draft.kind, stage: 'queued', progress: 0, startedAt: new Date().toISOString(), by: by || null,
    width: props.width, height: props.height, seconds: draft.kind === 'video' ? Math.round(props.frames / props.fps * 10) / 10 : null,
    blobPath: DRAFT_PREFIX + draft.brand + '/renders/server-' + draft.id + '-' + Date.now() + '.' + ext,
  };
  await setJob(draft.id, job);
  const run = () => (draft.kind === 'video' ? runVideo(draft, job, props) : runStill(draft, job, props))
    .catch((err) => failJob(draft, job, err.message || err).catch(() => {}));
  return { job, run };
}

async function runVideo(draft, job, props) {
  const sandbox = await openSandbox(() => setJob(draft.id, { ...job, stage: 'preparing' }));
  try {
    await setJob(draft.id, { ...job, stage: 'starting' });
    const { sandboxId, cmdId } = await renderMediaOnVercel({
      sandbox, compositionId: 'ad', inputProps: props, codec: 'h264', videoBitrate: '8M',
      licenseKey: licenseKey(), timeoutInMilliseconds: 90000, logLevel: 'warn',
      detached: true, detachedSandboxTimeoutInMilliseconds: DETACHED_LIMIT_MS,
      vercelBlob: { blobToken: blobToken(), access: 'public', blobPath: job.blobPath },
    });
    await setJob(draft.id, { ...job, stage: 'rendering', sandboxId, cmdId });
  } catch (err) {
    await sandbox.stop().catch(() => {});
    throw err;
  }
}

async function runStill(draft, job, props) {
  const sandbox = await openSandbox(() => setJob(draft.id, { ...job, stage: 'preparing' }));
  try {
    await setJob(draft.id, { ...job, stage: 'rendering', sandboxId: sandbox.sandboxId });
    const { sandboxFilePath, contentType } = await renderStillOnVercel({
      sandbox, compositionId: 'still', inputProps: props, imageFormat: 'jpeg', jpegQuality: 92,
      licenseKey: licenseKey(), timeoutInMilliseconds: 90000, logLevel: 'warn', outputFile: '/tmp/still.jpg',
    });
    const { url, size } = await uploadToVercelBlob({
      sandbox, sandboxFilePath, contentType: contentType || 'image/jpeg', blobToken: blobToken(), access: 'public', blobPath: job.blobPath,
    });
    await finishJob(draft, { ...job, sandboxId: sandbox.sandboxId }, { url, size, contentType: 'image/jpeg' });
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

/**
 * Looks at a draft's render and settles it if it has finished. Returns the draft as it
 * now stands, with `job.progress` filled in from the sandbox while it renders.
 */
export async function checkRender(draft) {
  const job = activeJob(draft.output);
  if (!job) return draft;
  const reread = async () => getDraft(draft.id);
  // Not rendering yet: still in after(), or that request died.
  if (!job.cmdId) {
    if (jobExpired(job)) { await failJob(draft, job, 'The render never started. Try again.'); return reread(); }
    return draft;
  }
  const p = await getRenderProgress({ sandboxId: job.sandboxId, cmdId: job.cmdId }).catch((err) => ({ stage: 'error', message: err.message }));
  if (p.stage === 'done') { await finishJob(draft, job, p); return reread(); }
  if (p.stage === 'error') { await failJob(draft, job, p.message); await stopSandbox(job.sandboxId); return reread(); }
  if (p.stage === 'expired') {
    // The sandbox has gone: the file at our path says whether it got there first.
    const file = await head(job.blobPath).catch(() => null);
    if (file) await finishJob(draft, job, { url: file.url, size: file.size, contentType: file.contentType });
    else await failJob(draft, job, 'The render stopped before the video was saved. Try again.');
    return reread();
  }
  const progress = Math.max(0, Math.min(0.99, Number(p.overallProgress) || 0));
  const stage = p.stage === 'uploading' ? 'uploading' : 'rendering';
  return { ...draft, output: { ...draft.output, job: { ...job, stage, progress } } };
}

/** Settles every draft with a render in flight; the ingest cron calls this. */
export async function settleRenders() {
  const { rows } = await dbQuery(
    `SELECT id FROM creative_drafts WHERE jsonb_typeof(output) = 'object' AND output ? 'job'
       AND output->'job'->>'stage' <> 'failed' LIMIT 20`);
  let settled = 0;
  for (const { id } of rows) {
    const d = await getDraft(id);
    if (!d) continue;
    const after = await checkRender(d).catch(() => d);
    if (!activeJob(after.output)) settled++;
  }
  return { checked: rows.length, settled };
}
