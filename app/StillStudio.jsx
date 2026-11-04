'use client';
// The Ads tab's image builder: static ad images, the still counterpart of the video
// builder (app/AdStudio.jsx), and sharing its pictures (the same picks from the library
// and uploads), its brand kit and style, its Instagram text and its looks. Options come
// from the templates in lib/stillPlans.js (instant) or from Claude (plans with copy);
// each is previewed, tweaked, rendered as one frame on this device, and sent to the
// brand's Meta ad image library. The Ads tab's own form then builds a single image ad and,
// optionally, a paused ad. Nothing is stored, the same rule as the video builder.
import { useEffect, useMemo, useRef, useState } from 'react';
import { persistAssets, storeRender, saveDraft as saveDraftApi, startServerRender, pollRenders, renderJob, renderFailed, renderStatusText } from './draftsClient.js';
import { Thumbnail } from '@remotion/player';
import StillAd from './StillTemplates.jsx';
import { loadKit, assetFromFile, releaseAssets } from './AdStudio.jsx';
import { fxTextures } from './mediaProbe.js';
import { ASPECTS, FILTERS, TEXT_STYLES, TEXT_BOXES } from '../lib/adPlans.js';
import { STILL_TEMPLATES, STILL_KEYS, GRID_GAPS, TEXT_ALIGNS, TEXT_COLORS, TEXT_BOXES_BG, textDefaults, BENEFIT_ICONS, normalizeStill, templateStills } from '../lib/stillPlans.js';

const MAX_ASSETS = 20;
const dimsOf = (p) => ASPECTS[p && p.aspect] || ASPECTS['9:16'];
let seq = 0;
const newKey = () => 'st' + (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const toB64 = (blob) => new Promise((resolve) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1]);
  fr.readAsDataURL(blob);
});

export default function StillStudio({ brand, brandName, accent, assets, setAssets, post, onSent, onReset, busyAdding, openDraft = null }) {
  const [aspect, setAspect] = useState('4:5');
  const [notes, setNotes] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [kit, setKit] = useState([]);
  const [kitStyle, setKitStyle] = useState(null);
  const [kitState, setKitState] = useState('loading');
  const [fx, setFx] = useState(null);
  const [options, setOptions] = useState([]);          // [{ key, source, plan }]
  const [current, setCurrent] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [render, setRender] = useState(null);          // { key, stamp, status, blob, url, error }
  const [send, setSend] = useState(null);              // { key, stage, error }
  const [sel, setSel] = useState('headline');          // the placed element being edited
  const fileInput = useRef(null);

  useEffect(() => { fxTextures().then(setFx).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setKitState('loading'); setOptions([]); setCurrent(''); setRender(null); setSend(null);
    loadKit(brand).then(({ assets: k, style }) => { if (live) { setKit(k); setKitStyle(style); setKitState('ready'); } else releaseAssets(k); })
      .catch(() => { if (live) { setKit([]); setKitState('failed'); } });
    return () => { live = false; setKit((k) => { releaseAssets(k.filter((a) => a.kind !== 'audio')); return []; }); };
  }, [brand]);

  const pics = assets.filter((a) => a.kind === 'image');
  const all = useMemo(() => [...assets, ...kit], [assets, kit]);
  const byId = useMemo(() => Object.fromEntries(all.map((a) => [a.id, a])), [all]);
  const fonts = useMemo(() => Object.fromEntries(kit.filter((a) => a.kind === 'font').map((a) => [a.id, a.family])), [kit]);
  const logos = kit.filter((a) => a.kind === 'logo');

  const opt = options.find((o) => o.key === current) || null;
  const plan = opt ? opt.plan : null;
  const dims = ASPECTS[(plan && plan.aspect) || aspect];

  const tex = useMemo(() => ({ fx }), [fx]);
  const inputProps = useMemo(() => ({ plan, assets: byId, brandName, accent, fonts, style: kitStyle, tex }), [plan, byId, brandName, accent, fonts, kitStyle, tex]);
  const stamp = plan ? JSON.stringify(plan) : '';
  const rendered = render && opt && render.key === opt.key && render.stamp === stamp && render.status === 'done' ? render : null;

  async function addFiles(files) {
    setAddError(''); setAdding(true);
    try {
      for (const f of [...files].slice(0, Math.max(0, MAX_ASSETS - assets.length))) {
        if (!f.type.startsWith('image/')) { setAddError('The image builder takes images only.'); continue; }
        try { const a = await assetFromFile(f); setAssets((xs) => [...xs, a]); } catch (err) { setAddError(String(err.message || err)); }
      }
    } finally {
      setAdding(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function addOptions(plans, source) {
    const made = plans.map((p) => ({ key: newKey(), source, plan: p }));
    setOptions((os) => [...os, ...made]);
    if (made.length) setCurrent(made[0].key);
    return made;
  }

  // ---- drafts ----
  // Saves an option as a draft: the pictures it uses are stored first (once each), then
  // the plan, and the rendered file when there is one. The draft id stays on the option,
  // so saving again updates the same draft.
  const [draftMsg, setDraftMsg] = useState({});           // option key -> message
  async function saveOption(key, outputBlob) {
    const o = optionsRef.current.find((x) => x.key === key);
    if (!o) return;
    setDraftMsg((m) => ({ ...m, [key]: 'Saving to Drafts...' }));
    try {
      const plan = normalizeStill(o.plan, all) || o.plan;
      const stored = await persistAssets(brand, assets, plan, (id, url) => setAssets((xs) => xs.map((a) => (a.id === id ? { ...a, storedUrl: url } : a))));
      let output;
      if (outputBlob) {
        const url = await storeRender(brand, outputBlob, (plan.title || 'image') + (outputBlob.type === 'video/mp4' ? '.mp4' : '.jpg'));
        output = { url, contentType: outputBlob.type, size: outputBlob.size, width: dimsOf(plan).width, height: dimsOf(plan).height };
      }
      const d = await saveDraftApi({ id: o.draftId || undefined, brand, kind: 'image', title: plan.title, plan, assets: stored, ...(output ? { output } : {}),
        source: o.source === 'draft' ? undefined : { madeWith: o.source } });
      setOptions((os) => os.map((x) => (x.key === key ? { ...x, draftId: d.id } : x)));
      setDraftMsg((m) => ({ ...m, [key]: output ? 'Saved to Drafts with the rendered file.' : 'Saved to Drafts.' }));
      return d.id;
    } catch (err) {
      setDraftMsg((m) => ({ ...m, [key]: 'Not saved: ' + String(err.message || err) }));
      return null;
    }
  }

  // The image rendered on the server (lib/serverRender.js) from the saved draft, for a phone
  // or a browser that cannot render; same flow as the video builder's.
  const serverRun = useRef(0);
  async function serverRender() {
    if (!plan) return;
    const run = ++serverRun.current;
    const live = () => serverRun.current === run;
    const key = opt.key, mine = stamp;
    if (render && render.url) URL.revokeObjectURL(render.url);
    const set = (r) => { if (live()) setRender({ key, stamp: mine, server: true, ...r }); };
    set({ status: 'rendering', note: 'Saving the draft...' }); setSend(null); onReset();
    try {
      const id = await saveOption(key);
      if (!id) throw new Error('The draft could not be saved, so the server has nothing to render.');
      let job = await startServerRender(id, accent);
      set({ status: 'rendering', note: renderStatusText(job) });
      while (live()) {
        await new Promise((r) => setTimeout(r, 3000));
        if (!live()) return;
        const o = (await pollRenders([id]).catch(() => ({})))[id];
        if (!o || o.error) continue;
        if (renderFailed(o)) throw new Error(renderFailed(o));
        job = renderJob(o);
        if (job) { set({ status: 'rendering', note: renderStatusText(job) }); continue; }
        if (!o.url) throw new Error('The render finished without a file. Try again.');
        const blob = await (await fetch(o.url)).blob();
        set({ status: 'done', blob, url: URL.createObjectURL(blob) });
        setDraftMsg((m) => ({ ...m, [key]: 'Rendered on the server and saved to Drafts.' }));
        return;
      }
    } catch (err) {
      set({ status: 'failed', error: String((err && err.message) || err) });
    }
  }
  const optionsRef = useRef([]);
  useEffect(() => { optionsRef.current = options; }, [options]);

  // A draft opened from the Drafts tab arrives as `openDraft`, once the brand kit it may
  // refer to is loaded, and becomes an option tied to that draft.
  const openedRef = useRef(null);
  useEffect(() => {
    if (!openDraft || kitState !== 'ready' || openedRef.current === openDraft.id) return;
    const plan = normalizeStill(openDraft.plan, all);
    if (!plan) return;
    openedRef.current = openDraft.id;
    const made = addOptions([plan], 'draft');
    if (made[0]) setOptions((os) => os.map((x) => (x.key === made[0].key ? { ...x, draftId: openDraft.id } : x)));
  }, [openDraft, kitState, all]);
  function makeTemplates() {
    setPlanError('');
    addOptions(templateStills(all, { aspect, brandName }), 'template');
  }

  async function planWithClaude() {
    setPlanError(''); setPlanning(true);
    try {
      const { ok, d } = await post({
        action: 'plan-still', brand, aspect, notes,
        previous: options.filter((o) => o.source === 'claude').map((o) => o.plan.title + ': ' + o.plan.headline),
        assets: all.filter((a) => a.kind === 'image' || a.kind === 'logo').map((a) => ({
          id: a.id, kind: a.kind, title: a.title, name: a.name, width: a.width, height: a.height,
          thumb: a.thumb ? { mediaType: a.thumb.mediaType, data: a.thumb.data } : null,
        })),
      });
      if (!ok) return setPlanError(d.error || 'Claude could not plan the images.');
      addOptions((d.plans || []).map((p) => normalizeStill(p, all)).filter(Boolean), 'claude');
    } catch {
      setPlanError('Request failed.');
    } finally {
      setPlanning(false);
    }
  }

  // Text goes in as typed; everything else is re-checked straight away. Rendering
  // normalizes again.
  function edit(patch, { raw = false } = {}) {
    setOptions((os) => os.map((o) => (o.key !== current ? o
      : { ...o, plan: raw ? { ...o.plan, ...patch } : normalizeStill({ ...o.plan, ...patch }, all) || o.plan })));
  }
  // One placed element's settings (lib/stillPlans.js, `text`), changed and re-checked.
  function setText(el, patch) {
    const detach = el === 'sub' && ('x' in patch || 'y' in patch) ? { attach: false } : {};
    edit({ text: { ...plan.text, [el]: { ...plan.text[el], ...patch, ...detach } } });
  }
  function resetSpot(el) {
    const d = textDefaults(plan.template, plan.place)[el];
    edit({ text: { ...plan.text, [el]: { ...plan.text[el], x: d.x, y: d.y, w: d.w, align: d.align, v: d.v, size: 1, attach: !!d.attach } } });
  }

  function setSlot(i, id) {
    const images = plan.images.slice();
    images[i] = id;
    edit({ images });
  }

  async function doRender() {
    if (!plan) return;
    const key = opt.key, mine = stamp;
    if (render && render.url) URL.revokeObjectURL(render.url);
    serverRun.current++;
    setRender({ key, stamp: mine, status: 'rendering' }); setSend(null); onReset();
    try {
      const { renderStillOnWeb } = await import('@remotion/web-renderer');
      await Promise.all(kit.filter((a) => a.kind === 'font').map((a) => document.fonts.load('48px "' + a.family + '"').catch(() => null)));
      const final = normalizeStill(plan, all);
      if (final.filter && FILTERS[final.filter].fx && !fx) throw new Error('The look is still being prepared. Try again in a second.');
      const r = await renderStillOnWeb({
        composition: { id: 'still', component: StillAd, width: dims.width, height: dims.height, fps: 30, durationInFrames: 1 },
        inputProps: { ...inputProps, plan: final },
        frame: 0,
        licenseKey: process.env.NEXT_PUBLIC_REMOTION_LICENSE_KEY || null,
      });
      // JPEG keeps a full-size ad well under a megabyte, so it fits one request to Meta.
      const blob = await r.blob({ format: 'jpeg', quality: 0.92 });
      setRender({ key, stamp: mine, status: 'done', blob, url: URL.createObjectURL(blob) });
      saveOption(key, blob);
    } catch (err) {
      setRender({ key, stamp: mine, status: 'failed', error: String((err && err.message) || err) });
    }
  }

  async function sendToMeta() {
    if (!rendered) return;
    const key = rendered.key;
    setSend({ key, stage: 'sending' });
    try {
      const { ok, d } = await post({ action: 'image-to-meta', brand, b64: await toB64(rendered.blob), title: plan.title });
      if (!ok) return setSend({ key, stage: 'failed', error: d.error || 'Meta would not take the image.' });
      setSend({ key, stage: 'ready' });
      const handles = [...new Set(plan.images.map((id) => (byId[id] || {}).handle).filter(Boolean))];
      onSent({ hash: d.hash, title: plan.title, headline: plan.headline, handles, texts: [plan.headline, plan.sub].filter(Boolean),
        draftId: (options.find((o) => o.key === key) || {}).draftId || null });
    } catch {
      setSend({ key, stage: 'failed', error: 'Request failed.' });
    }
  }

  const tmpl = plan ? STILL_TEMPLATES[plan.template] : null;

  return (
    <>
      <div className="card">
        <div className="card-label">Image builder</div>
        <p className="pane-sub" style={{ marginTop: 0, marginBottom: 12 }}>
          Static ads from your mockups and photos, in {brandName}'s brand kit. Pick pictures from the library on the left or
          upload them; they are shared with the video builder. Everything is made on this device.
        </p>
        <div className="reply-actions" style={{ marginBottom: 10 }}>
          <button className="btn btn-ghost" type="button" onClick={() => fileInput.current && fileInput.current.click()} disabled={adding || assets.length >= MAX_ASSETS}>
            {adding ? 'Reading...' : '+ Upload images'}
          </button>
          <input ref={fileInput} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => addFiles(e.target.files)} />
          <span className="ledger-note">{pics.length} picture{pics.length === 1 ? '' : 's'}{busyAdding ? ' · loading from the library...' : ''}</span>
        </div>
        {addError && <div className="login-error" style={{ marginBottom: 10 }}>{addError}</div>}
        {pics.length > 0 && (
          <div className="as-cards" style={{ marginBottom: 10 }}>
            {pics.map((a) => (
              <div key={a.id} className="mk-item" title={a.title || a.name}>
                <img className="mk-thumb" src={a.src} alt="" />
                <span className="mk-title">{a.title || a.name}</span>
              </div>
            ))}
          </div>
        )}
        <div className="ledger-note" style={{ marginBottom: 10 }}>
          {kitState === 'loading' ? 'Loading the brand kit...' : kitStyle ? 'Drawn in ' + brandName + "'s brand style." : 'No brand style yet: set one under ' + brandName + ' in Settings.'}
        </div>
        <div className="field-row">
          <label className="field">
            <span>Shape</span>
            <select className="input" value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {Object.entries(ASPECTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Notes for Claude (optional)</span>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. gift guide, last chance, the new hoodies" />
          </label>
        </div>
        <div className="reply-actions">
          <button className="btn btn-primary" type="button" onClick={makeTemplates} disabled={!pics.length}>Make template options</button>
          <button className="btn btn-primary" type="button" onClick={planWithClaude} disabled={!pics.length || planning}>
            {planning ? 'Claude is planning...' : options.some((o) => o.source === 'claude') ? 'Plan 3 more with Claude' : 'Plan 3 with Claude'}
          </button>
          {!pics.length && <span className="ledger-note">Add at least one picture.</span>}
        </div>
        {planError && <div className="login-error" style={{ marginTop: 10 }}>{planError}</div>}
      </div>

      {options.length > 0 && (
        <div className="card">
          <div className="card-label">Options</div>
          <div className="si-strip">
            {options.map((o) => {
              const d = ASPECTS[o.plan.aspect];
              return (
                <button key={o.key} type="button" className={'si-opt' + (o.key === current ? ' picked' : '')} onClick={() => setCurrent(o.key)} title={o.plan.title}>
                  <div className="si-thumb" style={{ aspectRatio: d.width + ' / ' + d.height }}>
                    <Thumbnail component={StillAd} inputProps={{ ...inputProps, plan: o.plan }} frameToDisplay={0} durationInFrames={1} fps={30}
                      compositionWidth={d.width} compositionHeight={d.height} style={{ width: '100%', height: '100%' }} />
                  </div>
                  <span className="mk-title">{o.source === 'claude' ? '✦ ' : ''}{o.plan.title}</span>
                </button>
              );
            })}
          </div>

          {plan && (
            <div className="as-option" style={{ marginTop: 14 }}>
              <div>
                <div className="as-preview si-preview si-stage" style={{ aspectRatio: dims.width + ' / ' + dims.height }}>
                  <Thumbnail component={StillAd} inputProps={inputProps} frameToDisplay={0} durationInFrames={1} fps={30}
                    compositionWidth={dims.width} compositionHeight={dims.height} style={{ width: '100%', height: '100%' }} />
                  <DragLayer plan={plan} sel={sel} onPick={setSel} onMove={setText} />
                </div>
                <div className="ledger-note" style={{ textAlign: 'center', marginTop: 6 }}>Drag the dots to move the words, button and logo.</div>
              </div>
              <div className="as-edit">
                {plan.why && <div className="li-sub" style={{ marginBottom: 8 }}>{opt.source === 'claude' ? 'Planned by Claude' : 'Template'} · {plan.why}</div>}
                <div className="field-row">
                  <label className="field">
                    <span>Layout</span>
                    <select className="input" value={plan.template} onChange={(e) => edit({ template: e.target.value })}>
                      {STILL_KEYS.map((k) => <option key={k} value={k}>{STILL_TEMPLATES[k].label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Shape</span>
                    <select className="input" value={plan.aspect} onChange={(e) => edit({ aspect: e.target.value })}>
                      {Object.entries(ASPECTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </label>
                </div>
                <div className="li-name" style={{ margin: '2px 0 2px' }}>Pictures</div>
                <div className="ledger-note" style={{ marginBottom: 6 }}>
                  To show a different product, add its picture from the panel on the left (By product: a shot in Meta or Drafts, or
                  "Make a lifestyle shot"), then choose it here.
                </div>
                <div className="si-slots">
                  {plan.images.map((id, i) => (
                    <label key={i} className="si-slot">
                      <img src={(byId[id] || {}).src} alt="" />
                      <select className="input" value={id} onChange={(e) => setSlot(i, e.target.value)} aria-label={'Picture ' + (i + 1)}>
                        {pics.map((a) => <option key={a.id} value={a.id}>{a.title || a.name}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <WordsEditor plan={plan} tmpl={tmpl} sel={sel} setSel={setSel} logos={logos} edit={edit} setText={setText} resetSpot={resetSpot} />
                <div className="field-row">
                  <label className="field">
                    <span>Text style</span>
                    <select className="input" value={plan.textStyle} onChange={(e) => edit({ textStyle: e.target.value })}>
                      {Object.entries(TEXT_STYLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  {plan.textStyle !== 'brand' && (
                    <label className="field">
                      <span>Box</span>
                      <select className="input" value={plan.textBox} onChange={(e) => edit({ textBox: e.target.value })}>
                        {Object.entries(TEXT_BOXES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="field-row">
                  <label className="field">
                    <span>Look</span>
                    <select className="input" value={plan.filter || ''} onChange={(e) => edit({ filter: e.target.value || null })}>
                      <option value="">None</option>
                      {Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </label>
                  {plan.template.startsWith('grid') && (
                    <label className="field">
                      <span>Gaps</span>
                      <select className="input" value={plan.gap} onChange={(e) => edit({ gap: e.target.value })}>
                        {Object.entries(GRID_GAPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="reply-actions" style={{ marginTop: 6 }}>
                  <button className="btn btn-primary" type="button" onClick={doRender} disabled={render && render.status === 'rendering'}>
                    {render && render.status === 'rendering' ? (render.server ? render.note : 'Rendering...') : rendered ? '↻ Render again' : 'Render image'}
                  </button>
                  {!(render && render.status === 'rendering') && (
                    <button className="btn btn-ghost" type="button" onClick={serverRender}
                      title="Renders on Backstage's server: works from a phone, and carries on if you close the page.">Render on server</button>
                  )}
                  <button className="btn btn-ghost" type="button" onClick={() => { setOptions((os) => os.filter((o) => o.key !== opt.key)); setCurrent(''); }}>Remove option</button>
                  <button className="btn btn-ghost" type="button" onClick={() => saveOption(opt.key)}>{opt.draftId ? 'Update draft' : 'Save draft'}</button>
                </div>
                {draftMsg[opt.key] && <div className="ledger-note" style={{ marginTop: 8 }}>{draftMsg[opt.key]}</div>}
                {render && render.key === opt.key && render.status === 'failed' && <div className="login-error" style={{ marginTop: 10 }}>{render.error}</div>}
                {render && render.key === opt.key && render.status === 'done' && render.stamp !== stamp && (
                  <div className="ledger-note" style={{ marginTop: 8 }}>Edited since the last render. Render again to send this version.</div>
                )}
              </div>
            </div>
          )}

          {rendered && (
            <div className="as-result">
              <img className="si-result" src={rendered.url} alt="" />
              <div>
                <div className="li-sub" style={{ marginBottom: 8 }}>{mb(rendered.blob.size)} JPEG, {dims.width}x{dims.height}</div>
                <div className="reply-actions">
                  <button className="btn btn-primary" type="button" onClick={sendToMeta}
                    disabled={send && send.key === rendered.key && (send.stage === 'sending' || send.stage === 'ready')}>
                    {send && send.key === rendered.key && send.stage === 'sending' ? 'Sending...' : send && send.key === rendered.key && send.stage === 'ready' ? 'Sent to Meta' : 'Send to Meta'}
                  </button>
                  <a className="btn btn-ghost" href={rendered.url} download={brand + '-' + plan.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.jpg'}>Download</a>
                </div>
                {send && send.key === rendered.key && send.stage !== 'sending' && (
                  <div className="mk-dests" style={{ marginTop: 10 }}>
                    <div className="mk-dest">
                      <span className="mini-dot" style={{ background: send.stage === 'ready' ? 'var(--green)' : 'var(--red)' }} />
                      <span>{send.stage === 'ready' ? 'In the ad image library. Fill in the ad below and build it, or use it in a carousel.' : send.error}</span>
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

// ---- words, button and logo ------------------------------------------------------------

const ELEMENTS = { headline: 'Headline', sub: 'Line under', cta: 'Button', benefits: 'Benefits', tags: 'Price tags', logo: 'Logo' };
const LISTS = ['benefits', 'tags'];
const pct = (n) => Math.round(n * 100) + '%';

// Settings for one placed element at a time (chips pick which): on or off, the words,
// size, alignment, position, width, colour and a box behind it.
function WordsEditor({ plan, tmpl, sel, setSel, logos, edit, setText, resetSpot }) {
  // Benefits and price tags belong to the feature layout, or to a plan that already has them.
  const els = Object.keys(ELEMENTS).filter((el) => (el !== 'sub' || tmpl.sub > 0)
    && (!LISTS.includes(el) || plan.template === 'feature' || (plan[el] || []).length > 0));
  const el = els.includes(sel) ? sel : 'headline';
  const cfg = plan.text[el];
  const isText = el === 'headline' || el === 'sub';
  const isList = LISTS.includes(el);
  const on = el === 'logo' ? !!plan.logo : cfg.show;
  const items = isList ? plan[el] || [] : [];
  // Rows go in as typed (an empty new row would otherwise be dropped); rendering checks them.
  const setItems = (next) => edit({ [el]: next, text: { ...plan.text, [el]: { ...cfg, show: items.length === 0 && next.length > 0 ? true : cfg.show } } }, { raw: true });
  const maxLen = el === 'headline' ? tmpl.headline : el === 'sub' ? tmpl.sub : 24;
  const custom = /^#/.test(cfg.color || '');
  const rides = el === 'sub' && cfg.attach && plan.text.headline.show && !!plan.headline;
  return (
    <div className="si-words">
      <div className="si-chips">
        {els.map((k) => {
          const lit = k === 'logo' ? !!plan.logo : LISTS.includes(k) ? plan.text[k].show && (plan[k] || []).length > 0 : plan.text[k].show && !!plan[k];
          return (
            <button key={k} type="button" className={'chip' + (k === el ? ' active' : '')} onClick={() => setSel(k)}>
              <span className="mini-dot" style={{ background: lit ? 'var(--green)' : 'var(--faint)' }} />{ELEMENTS[k]}
            </button>
          );
        })}
      </div>

      {el === 'logo' ? (
        <label className="field">
          <span>Logo</span>
          <select className="input" value={plan.logo || ''} onChange={(e) => edit({ logo: e.target.value || null })}>
            <option value="">Off</option>
            {logos.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      ) : (
        <>
          <label className="si-check">
            <input type="checkbox" checked={cfg.show} onChange={(e) => setText(el, { show: e.target.checked })} />
            <span>Show the {ELEMENTS[el].toLowerCase()}</span>
          </label>
          {isList ? (
            <div className="si-list">
              {items.map((it, i) => (
                <div key={i} className="si-list-row">
                  {el === 'benefits' ? (
                    <>
                      <select className="input" value={it.icon} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, icon: e.target.value } : x)))} aria-label="Icon">
                        {BENEFIT_ICONS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <input className="input" value={it.text} maxLength={34} placeholder="e.g. Easy to customise"
                        onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                    </>
                  ) : (
                    <>
                      <input className="input" value={it.label} maxLength={22} placeholder="Prints from" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <input className="input" value={it.price} maxLength={12} placeholder="$39" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                      <input className="input" value={it.was} maxLength={12} placeholder="was (optional)" onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, was: e.target.value } : x)))} />
                    </>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove">×</button>
                </div>
              ))}
              {items.length < (el === 'benefits' ? 4 : 2) && (
                <button type="button" className="btn btn-ghost" onClick={() => setItems([...items, el === 'benefits' ? { icon: 'check', text: '' } : { label: '', price: '', was: '' }])}>
                  + Add {el === 'benefits' ? 'a benefit' : 'a price tag'}
                </button>
              )}
              {el === 'tags' && <div className="ledger-note">Only prices that are real on the store today.</div>}
              {el === 'benefits' && <div className="ledger-note">Only true claims: no free shipping or guarantees unless the store offers them.</div>}
            </div>
          ) : (
          <label className="field">
            <span>{el === 'cta' ? 'Button text' : 'Words'}</span>
            <input className="input" value={plan[el]} maxLength={maxLen}
              placeholder={el === 'sub' && plan.template === 'offer' ? 'e.g. Up to 60% off (only if the offer is real)' : el === 'cta' ? 'e.g. Shop now' : ''}
              onChange={(e) => edit({ [el]: e.target.value, ...(e.target.value && !cfg.show ? { text: { ...plan.text, [el]: { ...cfg, show: true } } } : {}) }, { raw: true })} />
          </label>
          )}
        </>
      )}

      {on && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Size · {pct(cfg.size)}</span>
              <input type="range" min={0.4} max={2.5} step={0.05} value={cfg.size} onChange={(e) => setText(el, { size: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Align</span>
              <select className="input" value={cfg.align} onChange={(e) => setText(el, { align: e.target.value })}>
                {Object.entries(TEXT_ALIGNS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          {rides ? (
            <div className="ledger-note" style={{ margin: '2px 0 10px' }}>
              Sits under the headline and moves with it.{' '}
              <button className="btn-link" type="button" onClick={() => setText('sub', { x: cfg.x, y: cfg.y })}>Place it on its own</button>
            </div>
          ) : (
          <div className="field-row">
            <label className="field">
              <span>Across · {Math.round(cfg.x)}%</span>
              <input type="range" min={0} max={100} step={0.5} value={cfg.x} onChange={(e) => setText(el, { x: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Down · {Math.round(cfg.y)}%</span>
              <input type="range" min={0} max={100} step={0.5} value={cfg.y} onChange={(e) => setText(el, { y: Number(e.target.value) })} />
            </label>
          </div>
          )}
          {el !== 'logo' && (
            <div className="field-row">
              {(isText || el === 'benefits') && !rides && (
                <label className="field">
                  <span>Width · {Math.round(cfg.w)}%</span>
                  <input type="range" min={20} max={100} step={1} value={cfg.w} onChange={(e) => setText(el, { w: Number(e.target.value) })} />
                </label>
              )}
              <label className="field">
                <span>{el === 'cta' ? 'Button colour' : el === 'tags' ? 'Price colour' : 'Colour'}</span>
                <div className="si-color">
                  <select className="input" value={custom ? '#' : cfg.color} onChange={(e) => setText(el, { color: e.target.value === '#' ? '#ffffff' : e.target.value })}>
                    {Object.entries(TEXT_COLORS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    <option value="#">Custom...</option>
                  </select>
                  {custom && <input type="color" value={cfg.color} onChange={(e) => setText(el, { color: e.target.value })} aria-label="Custom colour" />}
                </div>
              </label>
            </div>
          )}
          {(isText || el === 'tags') && (
            <div className="field-row">
              <label className="field">
                <span>{el === 'tags' ? 'Tag colour' : 'Box behind'}</span>
                <select className="input" value={cfg.bg} onChange={(e) => setText(el, { bg: e.target.value })}>
                  {Object.entries(TEXT_BOXES_BG).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              {el === 'headline' && (
                <label className="field">
                  <span>Capitals</span>
                  <select className="input" value={cfg.upper === undefined ? '' : cfg.upper ? 'up' : 'as'}
                    onChange={(e) => setText(el, { upper: e.target.value === '' ? undefined : e.target.value === 'up' })}>
                    <option value="">Brand style</option>
                    <option value="up">ALL CAPS</option>
                    <option value="as">As typed</option>
                  </select>
                </label>
              )}
            </div>
          )}
          <button className="btn btn-ghost" type="button" onClick={() => resetSpot(el)}>Reset position and size</button>
        </>
      )}
    </div>
  );
}

// Dots over the preview, one per element that is on, dragged to move it. Positions are %
// of the frame, so the preview's size does not matter; the centre snaps.
function DragLayer({ plan, sel, onPick, onMove }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const headOn = plan.text.headline.show && !!plan.headline;
  const filled = (el) => (LISTS.includes(el) ? (plan[el] || []).length > 0 : !!plan[el]);
  const spots = Object.keys(ELEMENTS).filter((el) => (el === 'logo' ? !!plan.logo
    : plan.text[el] && plan.text[el].show && filled(el) && !(el === 'sub' && plan.text.sub.attach && headOn)));
  const at = (e) => {
    const r = ref.current.getBoundingClientRect();
    const snap = (v) => (Math.abs(v - 50) < 1.5 ? 50 : Math.round(v * 2) / 2);
    return { x: snap(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))), y: snap(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100))) };
  };
  return (
    <div ref={ref} className="si-drag"
      onPointerMove={(e) => { if (drag.current) { const p = at(e); onMove(drag.current, p); } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {spots.map((el) => (
        <button key={el} type="button" className={'si-dot' + (el === sel ? ' on' : '')} title={'Drag to move the ' + ELEMENTS[el].toLowerCase()}
          style={{ left: plan.text[el].x + '%', top: plan.text[el].y + '%' }}
          onPointerDown={(e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drag.current = el; onPick(el); }}>
          <span>{ELEMENTS[el]}</span>
        </button>
      ))}
    </div>
  );
}
