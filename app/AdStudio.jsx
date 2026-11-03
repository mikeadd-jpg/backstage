'use client';
// The Ads tab's video builder. Pick mockups from the ad library or upload images, clips
// and songs; get cuts from three fixed templates (instant) or from Claude (three plans it
// writes after looking at the shots); preview, tweak the text, render, send to Meta.
// After that the Ads tab's normal video flow takes over: headline, link, primary text,
// build the creative, optionally a paused ad.
//
// Everything happens on this device. Uploads stay in the tab as blob: URLs, Remotion's
// web renderer encodes the MP4 here, and the file goes to Meta in pieces through
// /api/ads/video-upload. Nothing is stored anywhere, the same rule as Mockups: close the
// tab and the uploads and renders are gone.
import { useMemo, useRef, useState } from 'react';
import { Player } from '@remotion/player';
import AdVideo from './AdTemplates.jsx';
import {
  ASPECTS, TEMPLATES, TEMPLATE_KEYS, FPS, CHUNK_BYTES, timeline, planSeconds, templatePlans, detectTempo, normalizePlan,
} from '../lib/adPlans.js';

const MAX_ASSETS = 20;
const MAX_UPLOAD = 500 * 1024 * 1024;

let seq = 0;
const newId = (kind) => kind[0] + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// A small JPEG of an image or a video frame: shown in the list, and sent to Claude so it
// can see the shots. Never the full file.
function thumbOf(el, w, h) {
  const scale = Math.min(1, 512 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.72);
  return { url, mediaType: 'image/jpeg', data: url.split(',')[1] };
}

function probeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: thumbOf(img, img.naturalWidth, img.naturalHeight) });
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

function probeVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => resolve({ width: v.videoWidth, height: v.videoHeight, seconds: v.duration, thumb: thumbOf(v, v.videoWidth, v.videoHeight) });
    v.onerror = () => reject(new Error('That video could not be read. MP4 (H.264) and MOV from a phone are safest.'));
    v.src = src;
  });
}

async function probeAudio(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const beat = detectTempo(buf.getChannelData(0), buf.sampleRate);
    return { seconds: buf.duration, beat };
  } catch {
    throw new Error('That audio file could not be read. MP3, M4A or WAV work.');
  } finally {
    ctx.close();
  }
}

/** An uploaded file as a builder asset. */
export async function assetFromFile(file) {
  if (file.size > MAX_UPLOAD) throw new Error(file.name + ' is over ' + mb(MAX_UPLOAD) + '.');
  const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null;
  if (!kind) throw new Error(file.name + ' is not an image, video or audio file.');
  const src = URL.createObjectURL(file);
  try {
    const meta = kind === 'image' ? await probeImage(src) : kind === 'video' ? await probeVideo(src) : await probeAudio(file);
    return { id: newId(kind), kind, src, name: file.name, title: '', handle: '', origin: 'upload', ...meta };
  } catch (err) {
    URL.revokeObjectURL(src);
    throw err;
  }
}

/** A Meta ad library image as a builder asset, copied same-origin so the canvas can draw it. */
export async function assetFromLibrary(img) {
  const res = await fetch('/api/ads/media?url=' + encodeURIComponent(img.url));
  if (!res.ok) throw new Error('Could not load ' + (img.title || img.name) + ' from the ad library.');
  const src = URL.createObjectURL(await res.blob());
  const meta = await probeImage(src).catch((err) => { URL.revokeObjectURL(src); throw err; });
  return { id: newId('image'), kind: 'image', src, name: img.name, title: img.title || '', handle: img.handle || '', hash: img.hash, origin: 'library', ...meta };
}

export function releaseAssets(list) {
  for (const a of list || []) if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
}

export default function AdStudio({ brand, brandName, accent, assets, setAssets, post, onSent, onReset, busyAdding }) {
  const [aspect, setAspect] = useState('9:16');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [options, setOptions] = useState([]);           // [{ key, source, plan }]
  const [current, setCurrent] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [render, setRender] = useState(null);           // { key, stamp, status, progress, url, blob, error }
  const [send, setSend] = useState(null);               // { key, stage, pct, error }
  const abort = useRef(null);
  const sendRun = useRef(0);
  const fileInput = useRef(null);

  const byId = useMemo(() => Object.fromEntries(assets.map((a) => [a.id, a])), [assets]);
  const visuals = assets.filter((a) => a.kind !== 'audio');
  const firstSongBeat = useMemo(() => {
    const s = assets.find((a) => a.kind === 'audio');
    return s && s.beat ? { asset: s.id, ...s.beat } : null;
  }, [assets]);
  const opt = options.find((o) => o.key === current) || null;
  const plan = opt ? opt.plan : null;
  const stamp = plan ? JSON.stringify(plan) : '';
  const rendered = render && opt && render.key === opt.key && render.stamp === stamp ? render : null;
  const renderStale = render && opt && render.key === opt.key && render.stamp !== stamp && render.status === 'done';
  const dims = ASPECTS[(plan && plan.aspect) || aspect];
  const frames = plan ? timeline(plan).total : 1;
  const inputProps = useMemo(() => ({ plan, assets: byId, brandName, accent }), [plan, byId, brandName, accent]);

  async function addFiles(files) {
    setAddError(''); setAdding(true);
    try {
      const room = MAX_ASSETS - assets.length;
      const list = [...files].slice(0, Math.max(0, room));
      if (files.length > list.length) setAddError('The builder holds ' + MAX_ASSETS + ' assets; the rest were left out.');
      for (const f of list) {
        try {
          const a = await assetFromFile(f);
          setAssets((xs) => [...xs, a]);
        } catch (err) {
          setAddError(String(err.message || err));
        }
      }
    } finally {
      setAdding(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function remove(id) {
    releaseAssets(assets.filter((a) => a.id === id));
    setAssets((xs) => xs.filter((a) => a.id !== id));
    // Plans pointing at it drop that shot; one left with nothing goes.
    setOptions((os) => os.map((o) => ({ ...o, plan: normalizePlan(o.plan, assets.filter((a) => a.id !== id)) })).filter((o) => o.plan));
  }

  function move(i, dir) {
    setAssets((xs) => {
      const j = i + dir;
      if (j < 0 || j >= xs.length) return xs;
      const next = xs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function addOptions(plans, source) {
    const made = plans.map((p) => ({ key: newId('opt'), source, plan: p }));
    setOptions((os) => [...os, ...made]);
    if (made.length) setCurrent(made[0].key);
  }

  function makeTemplateCuts() {
    setPlanError('');
    addOptions(templatePlans(assets, { aspect, beat: firstSongBeat, brandName }), 'template');
  }

  async function planWithClaude() {
    setPlanError(''); setPlanning(true);
    try {
      const { ok, d } = await post({
        action: 'plan-video', brand, aspect, notes, beat: firstSongBeat,
        previous: options.filter((o) => o.source === 'claude').map((o) => o.plan.title + ': ' + o.plan.why),
        assets: assets.map((a) => ({
          id: a.id, kind: a.kind, title: a.title, name: a.name, seconds: a.seconds, width: a.width, height: a.height,
          thumb: a.thumb ? { mediaType: a.thumb.mediaType, data: a.thumb.data } : null,
        })),
      });
      if (!ok) return setPlanError(d.error || 'Claude could not plan the cuts.');
      // Checked again here against the assets as they are now.
      addOptions((d.plans || []).map((p) => normalizePlan(p, assets)).filter(Boolean), 'claude');
    } catch {
      setPlanError('Request failed.');
    } finally {
      setPlanning(false);
    }
  }

  // Text edits go in as typed (normalizing would trim the space being typed); structure
  // edits are re-checked at once. The render normalizes everything again.
  function editPlan(patch, { raw = false } = {}) {
    setOptions((os) => os.map((o) => (o.key !== current ? o
      : { ...o, plan: raw ? { ...o.plan, ...patch } : normalizePlan({ ...o.plan, ...patch }, assets) || o.plan })));
  }
  function editScene(i, patch, opts) {
    editPlan({ scenes: plan.scenes.map((s, k) => (k === i ? { ...s, ...patch } : s)) }, opts);
  }
  function dropOption(key) {
    setOptions((os) => os.filter((o) => o.key !== key));
    if (current === key) setCurrent('');
  }

  async function doRender() {
    if (!plan) return;
    if (abort.current) abort.current.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const key = opt.key, mine = stamp;
    if (render && render.url) URL.revokeObjectURL(render.url);
    setRender({ key, stamp: mine, status: 'rendering', progress: 0 });
    setSend(null); onReset();
    try {
      const { renderMediaOnWeb, canRenderMediaOnWeb } = await import('@remotion/web-renderer');
      const check = await canRenderMediaOnWeb({ width: dims.width, height: dims.height, container: 'mp4' });
      if (!check.canRender) {
        const why = check.issues.filter((x) => x.severity === 'error').map((x) => x.message).join(' ');
        throw new Error('This browser cannot render video: ' + (why || 'no WebCodecs') + '. Use a recent Chrome or Edge on a computer.');
      }
      const { getBlob } = await renderMediaOnWeb({
        composition: { id: 'ad', component: AdVideo, width: dims.width, height: dims.height, fps: FPS,
          durationInFrames: timeline(normalizePlan(plan, assets)).total },
        inputProps: { ...inputProps, plan: normalizePlan(plan, assets) },
        container: 'mp4',
        videoBitrate: 'high',
        signal: ctl.signal,
        licenseKey: process.env.NEXT_PUBLIC_REMOTION_LICENSE_KEY || null,
        onProgress: (p) => setRender((r) => (r && r.stamp === mine ? { ...r, progress: p.progress } : r)),
      });
      const blob = await getBlob();
      setRender({ key, stamp: mine, status: 'done', progress: 1, blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      if (ctl.signal.aborted) return setRender(null);
      setRender({ key, stamp: mine, status: 'failed', error: String((err && err.message) || err) });
    }
  }

  // Meta's chunked upload, one piece per request, then the same processing poll as a
  // Canva video. A newer send or a new render abandons this one.
  async function sendToMeta() {
    if (!rendered || !rendered.blob) return;
    const mine = ++sendRun.current;
    const live = () => sendRun.current === mine;
    const key = rendered.key;
    const blob = rendered.blob;
    const fail = (error) => { if (live()) setSend({ key, stage: 'failed', error }); };
    const call = async (q, body) => {
      const res = await fetch('/api/ads/video-upload?' + new URLSearchParams({ brand, ...q }), { method: 'POST', body });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Upload failed.');
      return d;
    };
    try {
      setSend({ key, stage: 'uploading', pct: 0 });
      let { sessionId, videoId, start, end } = await call({ phase: 'start', size: String(blob.size) });
      while (start < blob.size && live()) {
        const stop = Math.min(blob.size, start + CHUNK_BYTES, end > start ? end : blob.size);
        const next = await call({ phase: 'transfer', session: sessionId, start: String(start) }, blob.slice(start, stop));
        if (!(next.start > start) && next.start !== next.end) throw new Error('Meta stopped accepting the upload. Send it again.');
        ({ start, end } = next);
        if (start === end) break;
        setSend({ key, stage: 'uploading', pct: Math.round((start / blob.size) * 100) });
      }
      if (!live()) return;
      await call({ phase: 'finish', session: sessionId, name: plan ? plan.title : 'video' });

      setSend({ key, stage: 'processing' });
      for (let i = 0; i < 120 && live(); i++) {           // about ten minutes
        await wait(5000);
        const r = await post({ action: 'video-status', brand, videoId });
        if (!r.ok) return fail(r.d.error || 'Could not check the video in Meta.');
        if (r.d.status === 'error') return fail(r.d.error);
        if (r.d.status === 'ready') {
          if (!live()) return;
          setSend({ key, stage: 'ready' });
          const sent = options.find((o) => o.key === key);
          const handles = [...new Set((sent ? sent.plan.scenes : []).map((s) => (byId[s.asset] || {}).handle).filter(Boolean))];
          const texts = (sent ? sent.plan.scenes : []).map((s) => s.text).filter(Boolean);
          return onSent({ videoId, title: sent ? sent.plan.title : '', headline: sent ? sent.plan.end.headline : '', handles, texts });
        }
      }
      fail('Meta is still processing the video. Send it again in a few minutes.');
    } catch (err) {
      fail(String(err.message || err));
    }
  }

  const sending = send && (send.stage === 'uploading' || send.stage === 'processing');

  return (
    <>
      <div className="card">
        <div className="card-label">Video builder</div>
        <p className="pane-sub" style={{ marginTop: 0, marginBottom: 12 }}>
          Pick mockups from the library on the left, or add your own images, clips and songs. Everything stays on this
          device: the video is made here and sent straight to {brandName}'s ad account.
        </p>

        <div className="reply-actions" style={{ marginBottom: 10 }}>
          <button className="btn btn-ghost" type="button" onClick={() => fileInput.current && fileInput.current.click()}
            disabled={adding || assets.length >= MAX_ASSETS}>
            {adding ? 'Reading...' : '+ Upload images, video or audio'}
          </button>
          <input ref={fileInput} type="file" multiple accept="image/*,video/*,audio/*" style={{ display: 'none' }}
            onChange={(e) => addFiles(e.target.files)} />
          <span className="ledger-note">{assets.length} of {MAX_ASSETS}{busyAdding ? ' · loading from the library...' : ''}</span>
        </div>
        {addError && <div className="login-error" style={{ marginBottom: 10 }}>{addError}</div>}

        {assets.length === 0 ? (
          <div className="ledger-note">Nothing picked yet.</div>
        ) : (
          <div className="as-list">
            {assets.map((a, i) => (
              <div className="as-row" key={a.id}>
                {a.kind === 'audio'
                  ? <span className="as-thumb as-audio">&#9835;</span>
                  : <img className="as-thumb" src={a.kind === 'image' ? a.src : a.thumb && a.thumb.url} alt="" />}
                <div className="as-meta">
                  <div className="li-name">{a.title || a.name}</div>
                  <div className="li-sub">
                    {a.kind}{a.seconds ? ' · ' + a.seconds.toFixed(1) + 's' : ''}
                    {a.kind === 'audio' && (a.beat ? ' · ' + a.beat.bpm + ' BPM' : ' · no clear beat')}
                    {a.origin === 'library' ? ' · ad library' : ''}
                  </div>
                </div>
                <div className="as-actions">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">&uarr;</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => move(i, 1)} disabled={i === assets.length - 1} aria-label="Move down">&darr;</button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => remove(a.id)} aria-label="Remove">&times;</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="field-row" style={{ marginTop: 12 }}>
          <label className="field">
            <span>Shape</span>
            <select className="input" value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {Object.entries(ASPECTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Notes for Claude (optional)</span>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Halloween drop, moody, lead with the hoodie" />
          </label>
        </div>
        <div className="reply-actions">
          <button className="btn btn-primary" type="button" onClick={makeTemplateCuts} disabled={!visuals.length}>Make 3 template cuts</button>
          <button className="btn btn-primary" type="button" onClick={planWithClaude} disabled={!visuals.length || planning}>
            {planning ? 'Claude is planning...' : options.some((o) => o.source === 'claude') ? 'Plan 3 more with Claude' : 'Plan 3 with Claude'}
          </button>
          {!visuals.length && <span className="ledger-note">Add at least one image or video.</span>}
        </div>
        {planError && <div className="login-error" style={{ marginTop: 10 }}>{planError}</div>}
      </div>

      {options.length > 0 && (
        <div className="card">
          <div className="card-label">Options</div>
          <div className="pf-chips" role="tablist" aria-label="Cuts" style={{ marginBottom: 12 }}>
            {options.map((o) => (
              <button key={o.key} type="button" role="tab" aria-selected={o.key === current}
                className={'chip' + (o.key === current ? ' active' : '')} onClick={() => setCurrent(o.key)}>
                {o.source === 'claude' ? '✦ ' : ''}{o.plan.title} · {planSeconds(o.plan).toFixed(0)}s
              </button>
            ))}
          </div>

          {!plan ? (
            <div className="ledger-note">Pick an option to preview it.</div>
          ) : (
            <div className="as-option">
              <div className="as-preview" style={{ aspectRatio: dims.width + ' / ' + dims.height }}>
                <Player component={AdVideo} inputProps={inputProps} durationInFrames={frames} fps={FPS}
                  compositionWidth={dims.width} compositionHeight={dims.height}
                  style={{ width: '100%', height: '100%' }} controls loop acknowledgeRemotionLicense />
              </div>
              <div className="as-edit">
                <div className="li-sub" style={{ marginBottom: 8 }}>
                  {o2label(opt.source)} · {plan.why}
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Template</span>
                    <select className="input" value={plan.template} onChange={(e) => editPlan({ template: e.target.value })}>
                      {TEMPLATE_KEYS.map((k) => <option key={k} value={k}>{TEMPLATES[k].label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Song</span>
                    <select className="input" value={plan.audio ? plan.audio.asset : ''}
                      onChange={(e) => {
                        const s = byId[e.target.value];
                        editPlan({ audio: s ? { asset: s.id, from: s.beat ? s.beat.offset : 0 } : null });
                      }}>
                      <option value="">None (clips keep their own sound)</option>
                      {assets.filter((a) => a.kind === 'audio').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="as-scenes">
                  {plan.scenes.map((s, i) => {
                    const a = byId[s.asset];
                    return (
                      <div className="as-scene" key={i}>
                        <img className="as-thumb" src={a ? (a.kind === 'image' ? a.src : a.thumb && a.thumb.url) : ''} alt="" />
                        <input className="input" value={s.text} placeholder="no text" maxLength={TEMPLATES[plan.template].textMax}
                          onChange={(e) => editScene(i, { text: e.target.value }, { raw: true })} aria-label={'Text on shot ' + (i + 1)} />
                        <input className="input as-secs" type="number" step="0.1" min={TEMPLATES[plan.template].min} max={TEMPLATES[plan.template].max}
                          value={s.seconds} onChange={(e) => editScene(i, { seconds: Number(e.target.value) })} aria-label={'Seconds for shot ' + (i + 1)} />
                      </div>
                    );
                  })}
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>End card headline</span>
                    <input className="input" value={plan.end.headline} maxLength={60} onChange={(e) => editPlan({ end: { ...plan.end, headline: e.target.value } }, { raw: true })} />
                  </label>
                  <label className="field">
                    <span>End card button</span>
                    <input className="input" value={plan.end.cta} maxLength={24} onChange={(e) => editPlan({ end: { ...plan.end, cta: e.target.value } }, { raw: true })} />
                  </label>
                </div>

                <div className="reply-actions" style={{ marginTop: 6 }}>
                  <button className="btn btn-primary" type="button" onClick={doRender} disabled={(render && render.status === 'rendering') || sending}>
                    {render && render.status === 'rendering' ? 'Rendering ' + Math.round((render.progress || 0) * 100) + '%...'
                      : rendered ? '↻ Render again' : 'Render video'}
                  </button>
                  {render && render.status === 'rendering' && (
                    <button className="btn btn-ghost" type="button" onClick={() => abort.current && abort.current.abort()}>Cancel</button>
                  )}
                  <button className="btn btn-ghost" type="button" onClick={() => dropOption(opt.key)}>Remove option</button>
                </div>
                {render && render.key === opt.key && render.status === 'failed' && <div className="login-error" style={{ marginTop: 10 }}>{render.error}</div>}
                {renderStale && <div className="ledger-note" style={{ marginTop: 8 }}>Edited since the last render. Render again to send this version.</div>}
                {render && render.status === 'rendering' && (
                  <div className="ledger-note" style={{ marginTop: 8 }}>Keep this tab open and in front while it renders.</div>
                )}
              </div>
            </div>
          )}

          {rendered && rendered.status === 'done' && (
            <div className="as-result">
              <video className="ad-video" src={rendered.url} controls playsInline preload="metadata" />
              <div>
                <div className="li-sub" style={{ marginBottom: 8 }}>{mb(rendered.blob.size)} MP4, {dims.width}x{dims.height}, {planSeconds(plan).toFixed(1)}s</div>
                <div className="reply-actions">
                  <button className="btn btn-primary" type="button" onClick={sendToMeta} disabled={sending || (send && send.key === rendered.key && send.stage === 'ready')}>
                    {sending ? 'Sending...' : send && send.key === rendered.key && send.stage === 'ready' ? 'Sent to Meta' : 'Send to Meta'}
                  </button>
                  <a className="btn btn-ghost" href={rendered.url} download={brand + '-' + plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.mp4'}>Download</a>
                </div>
                {send && send.key === rendered.key && (
                  <div className="mk-dests" style={{ marginTop: 10 }}>
                    <div className="mk-dest">
                      <span className="mini-dot" style={{ background: send.stage === 'failed' ? 'var(--red)' : send.stage === 'ready' ? 'var(--green)' : 'var(--amber)' }} />
                      <span>
                        {send.stage === 'uploading' ? 'Sending to Meta... ' + (send.pct || 0) + '%'
                          : send.stage === 'processing' ? 'Meta is processing...'
                          : send.stage === 'ready' ? 'In the ad account. Fill in the ad below and build it.'
                          : send.error}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

const o2label = (source) => (source === 'claude' ? 'Planned by Claude' : 'Template');
