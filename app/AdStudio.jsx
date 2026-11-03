'use client';
// The Ads tab's video builder. Pick mockups from the ad library or upload images, clips
// and songs; get cuts from three fixed templates (instant) or from Claude (three plans it
// writes after looking at the shots); preview, tweak the text, render, send to Meta.
// After that the Ads tab's normal video flow takes over: headline, link, primary text,
// build the creative, optionally a paused ad.
//
// The brand kit from Settings (end card images, logos, fonts, approved music) is loaded
// for the store and offered in every option: the first of each kind is the default.
//
// Everything happens on this device. Uploads stay in the tab as blob: URLs, Remotion's
// web renderer encodes the MP4 here, and the file goes to Meta in pieces through
// /api/ads/video-upload. Nothing is stored anywhere, the same rule as Mockups: close the
// tab and the uploads and renders are gone.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Player } from '@remotion/player';
import AdVideo from './AdTemplates.jsx';
import {
  ASPECTS, TEMPLATES, TEMPLATE_KEYS, FPS, CHUNK_BYTES, timeline, planSeconds, templatePlans, normalizePlan,
  CAPTION_POSITIONS, CAPTION_STYLES, CAPTION_MAX, LOGO_POSITIONS, LOGO_SIZES, FILTERS,
} from '../lib/adPlans.js';
import { kitFontFamily, loadKitFont } from './BrandKit.jsx';
import { probeImage, probeVideo, probeAudio, renderableImage } from './mediaProbe.js';

const MAX_ASSETS = 20;
const MAX_UPLOAD = 500 * 1024 * 1024;

let seq = 0;
const newId = (kind) => kind[0] + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// The brand kit as builder assets, ids prefixed so they never meet an upload's. Images are
// copied to blob: URLs for the same canvas reason as library images; music streams from
// its Blob URL (the store sends CORS headers), since a brand may keep a lot of it.
async function loadKit(brand) {
  const d = await fetch('/api/brand-kit?brand=' + encodeURIComponent(brand)).then((r) => r.json());
  if (d.error) throw new Error(d.error);
  const out = [];
  for (const a of d.assets || []) {
    const id = 'k' + a.id;
    const base = { id, name: a.name, title: '', origin: 'kit', kitId: a.id, ...a.meta };
    if (a.kind === 'music') {
      out.push({ ...base, kind: 'audio', src: a.url, beat: a.meta.bpm ? { bpm: a.meta.bpm, period: a.meta.period, offset: a.meta.offset } : null });
    } else if (a.kind === 'font') {
      await loadKitFont(a).catch(() => null);
      out.push({ ...base, kind: 'font', family: kitFontFamily(a.id) });
    } else {
      const res = await fetch(a.url).catch(() => null);
      if (!res || !res.ok) continue;
      const img = await renderableImage(await res.blob()).catch(() => null);
      if (img) out.push({ ...base, kind: a.kind, ...img });
    }
  }
  return { assets: out, style: d.style || null };
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
  const [kit, setKit] = useState([]);
  const [kitState, setKitState] = useState('loading');  // loading | ready | failed
  const [kitStyle, setKitStyle] = useState(null);       // the brand's saved style, or null

  // A new store means a new kit, and options made from the old store's assets go.
  useEffect(() => {
    let live = true;
    setKitState('loading'); setOptions([]); setCurrent(''); setRender(null); setSend(null);
    loadKit(brand).then(({ assets: k, style: st }) => { if (live) { setKit(k); setKitStyle(st); setKitState('ready'); } else releaseAssets(k); })
      .catch(() => { if (live) { setKit([]); setKitState('failed'); } });
    return () => { live = false; setKit((k) => { releaseAssets(k.filter((a) => a.kind !== 'audio')); return []; }); };
  }, [brand]);

  // Everything a plan can point at: the person's assets, then the kit.
  const all = useMemo(() => [...assets, ...kit], [assets, kit]);
  const byId = useMemo(() => Object.fromEntries(all.map((a) => [a.id, a])), [all]);
  const fonts = useMemo(() => Object.fromEntries(kit.filter((a) => a.kind === 'font').map((a) => [a.id, a.family])), [kit]);
  const kitOf = (kind) => kit.filter((a) => a.kind === kind);
  const kitSongs = kit.filter((a) => a.kind === 'audio');
  const defaults = useMemo(() => ({
    endcard: (kit.find((a) => a.kind === 'endcard') || {}).id || null,
  }), [kit]);
  const visuals = assets.filter((a) => a.kind !== 'audio');
  const firstSongBeat = useMemo(() => {
    const s = assets.find((a) => a.kind === 'audio') || kitSongs[0];
    return s && s.beat ? { asset: s.id, ...s.beat } : null;
  }, [assets, kit]);
  const opt = options.find((o) => o.key === current) || null;
  const plan = opt ? opt.plan : null;
  const stamp = plan ? JSON.stringify(plan) : '';
  const rendered = render && opt && render.key === opt.key && render.stamp === stamp ? render : null;
  const renderStale = render && opt && render.key === opt.key && render.stamp !== stamp && render.status === 'done';
  const dims = ASPECTS[(plan && plan.aspect) || aspect];
  const frames = plan ? timeline(plan).total : 1;
  const inputProps = useMemo(() => ({ plan, assets: byId, brandName, accent, fonts, style: kitStyle }), [plan, byId, brandName, accent, fonts, kitStyle]);

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
    setOptions((os) => os.map((o) => ({ ...o, plan: normalizePlan(o.plan, all.filter((a) => a.id !== id)) })).filter((o) => o.plan));
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
    addOptions(templatePlans(all, { aspect, beat: firstSongBeat, brandName, defaults }), 'template');
  }

  async function planWithClaude() {
    setPlanError(''); setPlanning(true);
    try {
      const { ok, d } = await post({
        action: 'plan-video', brand, aspect, notes, beat: firstSongBeat,
        previous: options.filter((o) => o.source === 'claude').map((o) => o.plan.title + ': ' + o.plan.why),
        assets: all.filter((a) => a.kind !== 'font').map((a) => ({
          id: a.id, kind: a.kind, title: a.title, name: a.name, seconds: a.seconds, width: a.width, height: a.height,
          approved: a.origin === 'kit',
          thumb: a.thumb ? { mediaType: a.thumb.mediaType, data: a.thumb.data } : null,
        })),
      });
      if (!ok) return setPlanError(d.error || 'Claude could not plan the cuts.');
      // Checked again here against the assets as they are now.
      // Fonts are the brand style's, not Claude's.
      addOptions((d.plans || []).map((p) => normalizePlan({ ...p, font: null }, all)).filter(Boolean), 'claude');
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
      : { ...o, plan: raw ? { ...o.plan, ...patch } : normalizePlan({ ...o.plan, ...patch }, all) || o.plan })));
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
      // Kit fonts must be in document.fonts before the first frame is drawn.
      await Promise.all(kit.filter((a) => a.kind === 'font').map((a) => document.fonts.load('48px "' + a.family + '"').catch(() => null)));
      const final = normalizePlan(plan, all);
      const { getBlob } = await renderMediaOnWeb({
        composition: { id: 'ad', component: AdVideo, width: dims.width, height: dims.height, fps: FPS,
          durationInFrames: timeline(final).total },
        inputProps: { ...inputProps, plan: final },
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
        <div className="ledger-note" style={{ marginBottom: 10 }}>
          {kitState === 'loading' ? 'Loading the ' + brandName + ' brand kit...'
            : kitState === 'failed' ? 'Could not load the brand kit.'
            : kit.length === 0 ? 'No brand kit yet. Add end cards, logos, fonts and approved music under ' + brandName + ' in Settings.'
            : 'Brand kit: ' + [['endcard', 'end card'], ['logo', 'logo'], ['font', 'font'], ['audio', 'song']]
              .map(([k, label]) => { const n = kit.filter((a) => a.kind === k).length; return n ? n + ' ' + label + (n === 1 ? '' : 's') : null; })
              .filter(Boolean).join(', ') + '. Edit it in Settings.'}
        </div>

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
                      {kitSongs.length > 0 && (
                        <optgroup label="Approved for this brand">
                          {kitSongs.map((a) => <option key={a.id} value={a.id}>{a.name}{a.bpm ? ' · ' + a.bpm + ' BPM' : ''}</option>)}
                        </optgroup>
                      )}
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
                <div className="as-extra">
                  <label className="field">
                    <span>Text that stays on through every shot (optional)</span>
                    <input className="input" value={plan.caption ? plan.caption.text : ''} maxLength={CAPTION_MAX}
                      placeholder="e.g. The Halloween drop is here"
                      onChange={(e) => editPlan({ caption: e.target.value ? { position: 'top', style: 'plain', ...(plan.caption || {}), text: e.target.value } : null }, { raw: true })} />
                  </label>
                  {plan.caption && (
                    <div className="field-row">
                      <label className="field">
                        <span>Where</span>
                        <select className="input" value={plan.caption.position} onChange={(e) => editPlan({ caption: { ...plan.caption, position: e.target.value } })}>
                          {Object.entries(CAPTION_POSITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Look</span>
                        <select className="input" value={plan.caption.style} onChange={(e) => editPlan({ caption: { ...plan.caption, style: e.target.value } })}>
                          {Object.entries(CAPTION_STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                    </div>
                  )}
                  {plan.caption && plan.scenes.some((s) => s.text) && (
                    <div className="ledger-note" style={{ marginTop: -4, marginBottom: 8 }}>
                      Some shots also have their own text. Clear it above if the two crowd each other.
                      {' '}<button type="button" className="link-inline" onClick={() => editPlan({ scenes: plan.scenes.map((x) => ({ ...x, text: '' })) })}>Clear all shot text</button>
                    </div>
                  )}

                  <div className="field-row">
                    <label className="field">
                      <span>Font</span>
                      <select className="input" value={plan.font || ''} onChange={(e) => editPlan({ font: e.target.value || null })}>
                        <option value="">{kitStyle && kitStyle.fonts && kitStyle.fonts.headline ? 'Brand fonts' : 'Template default'}</option>
                        {kitOf('font').map((a) => <option key={a.id} value={a.id}>Headlines in {a.name}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Filter</span>
                      <select className="input" value={plan.filter || ''} onChange={(e) => editPlan({ filter: e.target.value || null })}>
                        <option value="">None</option>
                        {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="field-row">
                    <label className="field">
                      <span>Logo overlay</span>
                      <select className="input" value={plan.logo ? plan.logo.asset : ''}
                        onChange={(e) => editPlan({ logo: e.target.value ? { position: 'top-right', size: 'small', ...(plan.logo || {}), asset: e.target.value } : null })}>
                        <option value="">None</option>
                        {kitOf('logo').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </label>
                  </div>
                  {plan.logo && (
                    <div className="field-row">
                      <label className="field">
                        <span>Logo position</span>
                        <select className="input" value={plan.logo.position} onChange={(e) => editPlan({ logo: { ...plan.logo, position: e.target.value } })}>
                          {Object.entries(LOGO_POSITIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </label>
                      <label className="field">
                        <span>Logo size</span>
                        <select className="input" value={plan.logo.size} onChange={(e) => editPlan({ logo: { ...plan.logo, size: e.target.value } })}>
                          {Object.keys(LOGO_SIZES).map((k) => <option key={k} value={k}>{k[0].toUpperCase() + k.slice(1)}</option>)}
                        </select>
                      </label>
                    </div>
                  )}

                  <div className="li-name" style={{ margin: '4px 0 6px' }}>End card</div>
                  {kitOf('endcard').length > 0 && (
                    <div className="as-cards">
                      {kitOf('endcard').map((a) => {
                        const at = plan.end.cards.indexOf(a.id);
                        return (
                          <button key={a.id} type="button" className={'mk-item' + (at >= 0 ? ' picked' : '')} title={a.name}
                            onClick={() => editPlan({ end: { ...plan.end, cards: at >= 0 ? plan.end.cards.filter((x) => x !== a.id) : [...plan.end.cards, a.id] } })}>
                            {at >= 0 && <span className="ad-pos">{at + 1}</span>}
                            <img className="as-card-thumb" src={a.src} alt="" />
                            <span className="mk-title">{a.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={plan.end.generated !== false} disabled={!plan.end.cards.length}
                      onChange={(e) => editPlan({ end: { ...plan.end, generated: e.target.checked } })} />
                    {plan.end.cards.length ? 'Then the headline and button card' : 'Headline and button card'}
                  </label>
                  <div className="ledger-note" style={{ marginBottom: 8 }}>
                    {kitOf('endcard').length
                      ? 'Tick end card images to play them in that order, ' + 2 + 's each.'
                      : kitState === 'loading' ? 'Loading the brand kit...' : 'Add end card images to the brand kit in Settings to use your own.'}
                  </div>
                </div>
                {plan.end.generated !== false && <div className="field-row">
                  <label className="field">
                    <span>End card headline</span>
                    <input className="input" value={plan.end.headline} maxLength={60} onChange={(e) => editPlan({ end: { ...plan.end, headline: e.target.value } }, { raw: true })} />
                  </label>
                  <label className="field">
                    <span>End card button</span>
                    <input className="input" value={plan.end.cta} maxLength={24} onChange={(e) => editPlan({ end: { ...plan.end, cta: e.target.value } }, { raw: true })} />
                  </label>
                </div>}

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
