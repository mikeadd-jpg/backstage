'use client';
// Saving the video and image builders' work as drafts (lib/drafts.js). A plan points at
// pictures, clips and songs that live in the tab as blob: URLs, so before a draft is
// saved each one it uses is copied to Vercel Blob (drafts/<brand>/assets/), once: the
// stored URL is remembered on the asset, so saving again or saving another option that
// uses the same picture uploads nothing new. Brand kit files are already stored and are
// referred to by id. Rendered files go to drafts/<brand>/renders/.
import { upload } from '@vercel/blob/client';

export const OPEN_DRAFT_KEY = 'backstage.openDraft';   // { id }, read once by app/Ads.jsx

async function store(brand, folder, body, name, contentType) {
  const safe = String(name || 'file').toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(-60) || 'file';
  const blob = await upload('drafts/' + brand + '/' + folder + '/' + safe, body, {
    access: 'public', handleUploadUrl: '/api/drafts/upload', contentType: contentType || body.type || undefined,
    multipart: (body.size || 0) > 8 * 1024 * 1024,
  });
  return blob.url;
}

// Asset ids a plan uses: its shots, its song and nothing from the kit (those have ids
// starting with k and are already stored).
export function usedAssetIds(plan) {
  const ids = new Set();
  for (const s of (plan && plan.scenes) || []) ids.add(s.asset);
  for (const id of (plan && plan.images) || []) ids.add(id);
  if (plan && plan.audio) ids.add(plan.audio.asset);
  return [...ids].filter((id) => id && !String(id).startsWith('k'));
}

/**
 * Stores every asset `plan` uses that is not stored yet; `remember(id, url)` records the
 * stored URL on the builder's asset so it is never uploaded twice. Returns the plain
 * descriptions the draft keeps.
 */
export async function persistAssets(brand, assets, plan, remember) {
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  const out = [];
  for (const id of usedAssetIds(plan)) {
    const a = byId[id];
    if (!a) continue;
    let url = a.storedUrl;
    if (!url) {
      const blob = await (await fetch(a.src)).blob();
      url = await store(brand, 'assets', blob, a.name || id, blob.type);
      remember(id, url);
    }
    out.push({
      id, kind: a.kind, url, name: a.name || '', title: a.title || '', handle: a.handle || '', hash: a.hash || null,
      width: a.width || null, height: a.height || null, seconds: a.seconds || null, beat: a.beat || null,
      // A mockup picked from Drafts: cleanupDrafts keeps it while an ad draft uses it.
      ...(a.draftId ? { draftId: a.draftId } : {}),
    });
  }
  return out;
}

export async function storeRender(brand, blob, name) {
  return store(brand, 'renders', blob, name, blob.type);
}

export async function saveDraft(body) {
  const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', ...body }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Could not save the draft.');
  return d.draft;
}

/** A stored asset back as a builder asset: the file fetched into a blob: URL (the
 * renderer draws only same-origin pictures), keeping its id so the plan still matches. */
export async function restoreAsset(a) {
  const blob = await (await fetch(a.url)).blob();
  return { ...a, src: URL.createObjectURL(blob), storedUrl: a.url, origin: a.origin || 'draft' };
}

// ---- server renders (lib/serverRender.js, /api/renders) ----------------------------------

/** A render still in flight in a draft's output, or null. */
export const renderJob = (output) => (output && output.job && output.job.stage !== 'failed' ? output.job : null);
export const renderFailed = (output) => (output && output.job && output.job.stage === 'failed' ? output.job.error || 'The render failed.' : '');

const STAGE_TEXT = { queued: 'Starting', preparing: 'Setting up the renderer (first time only)', starting: 'Starting', rendering: 'Rendering', uploading: 'Saving' };
export function renderStatusText(job) {
  if (!job) return '';
  const pct = job.stage === 'rendering' && job.progress > 0 ? ' ' + Math.round(job.progress * 100) + '%' : '';
  return (STAGE_TEXT[job.stage] || 'Rendering') + pct + '...';
}

/** Starts a server render of a saved draft. Returns the job. */
export async function startServerRender(draftId, accent) {
  const res = await fetch('/api/renders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftId, accent }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Could not start the render.');
  return d.job;
}

/** Each draft's output as it now stands ({ id: output }), settling finished renders. */
export async function pollRenders(ids) {
  if (!ids.length) return {};
  const res = await fetch('/api/renders?ids=' + ids.join(','), { cache: 'no-store' });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Could not check the render.');
  return d.outputs || {};
}
