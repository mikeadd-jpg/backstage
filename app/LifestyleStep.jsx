'use client';
// The Ads tab's second step, between picking pictures (left) and naming and writing the ad:
// "Lifestyle shots". Every picture picked for the ad is listed; store mockups start ticked
// for a new lifestyle shot, pictures that already are lifestyle shots (in Meta, in Drafts)
// start unticked, and anything can be ticked or unticked. One button makes a shot for every
// ticked picture the Mockups tab's way: one /api/mockups request per shot, two at a time,
// results as they land, a failed one reported on its own row, a second press making only
// what is missing. Each picture gets its own scene (suggestScene, the other rows' scenes
// passed as already used); the server adds the store's models and notes, saves the shot to
// Drafts and print-checks it after.
//
// A finished shot takes its source picture's place in the ad's selection (`onMade`), and
// the Ads tab carries that selection between Carousel, Video builder and Image builder, so
// shots made for a carousel are there for the video and the static ad too. The tab keeps
// this step mounted across those three, so a run carries on while you switch.
import { useEffect, useRef, useState } from 'react';
import { PRESENTATIONS, presentationLine } from '../lib/stillPlans.js';

// Spending guard for one press, the same number as MAX_PRODUCTS in /api/mockups.
const MAX_SHOTS = 10;
const SHOT_COST = 0.25;           // high quality, lib/spend.js
const CONCURRENCY = 2;            // as in the Mockups tab: past two a rate limit is likelier than a speedup
const WRITING = ['queued', 'writing'];

async function mockupsPost(payload) {
  const res = await fetch('/api/mockups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ok: res.ok, status: res.status, d: await res.json().catch(() => ({})) };
}

// picks: [{ url, thumb, handle, title, side, lifestyle }] in ad order; url is what a shot is made from.
export default function LifestyleStep({ brand, picks, products, onMade }) {
  const [rows, setRows] = useState({});            // url -> { use, scene, used, state, error }
  const [shown, setShown] = useState(brand === 'wallspoke' ? 'room' : 'model');
  const [size, setSize] = useState('portrait');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const writing = useRef(new Set());
  const tried = useRef(new Set());                 // auto-written once; after that "Another scene" is the way

  useEffect(() => { setRows({}); setError(''); tried.current = new Set(); setShown(brand === 'wallspoke' ? 'room' : 'model'); }, [brand]);

  const byHandle = Object.fromEntries((products || []).map((p) => [p.handle, p]));
  const rowOf = (p) => rows[p.url] || { use: !p.lifestyle, scene: '', used: [], state: 'idle', error: '' };
  const update = (url, patch) => setRows((rs) => {
    const p = picksRef.current.find((x) => x.url === url);
    const cur = rs[url] || { use: p ? !p.lifestyle : false, scene: '', used: [], state: 'idle', error: '' };
    return { ...rs, [url]: { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) } };
  });

  const usable = picks.filter((p) => p.url);
  const ticked = usable.filter((p) => rowOf(p).use && rowOf(p).state !== 'done');
  const running = Object.values(rows).some((r) => r.state === 'making' || r.state === 'waiting');
  const scenesBusy = ticked.some((p) => WRITING.includes(rowOf(p).state));

  async function writeScene(url) {
    const p = picksRef.current.find((x) => x.url === url);
    if (!p || writing.current.has(url)) return;
    writing.current.add(url);
    update(url, { state: 'writing', error: '' });
    const others = Object.entries(rowsRef.current).filter(([u]) => u !== url).flatMap(([, r]) => [r.scene, ...(r.used || [])]).filter(Boolean);
    const mine = (rowsRef.current[url] || {}).used || [];
    const product = byHandle[p.handle] || {};
    try {
      const { ok, status, d } = await mockupsPost({ action: 'suggest-scene', brand,
        product: { title: p.title || product.title, productType: product.productType, image: p.url },
        current: (rowsRef.current[url] || {}).scene || '', previous: Array.from(new Set([...mine, ...others])).slice(0, 20), presentation: shown });
      if (status === 403) { setError('Making lifestyle shots needs the Mockups area on your role.'); return update(url, { state: 'idle' }); }
      if (!ok) return update(url, { state: 'idle', error: (d.error || 'Could not write a scene.') + ' Write one in the box.' });
      update(url, (r) => ({ scene: d.scene, used: [d.scene, ...(r.used || [])].slice(0, 6), state: 'idle' }));
    } catch {
      update(url, { state: 'idle', error: 'Could not write a scene. Write one in the box.' });
    } finally {
      writing.current.delete(url);
    }
  }

  async function writeScenes(urls) {
    for (const u of urls) update(u, { state: 'queued' });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
      while (next < urls.length) await writeScene(urls[next++]);
    }));
  }

  // A ticked picture with no scene yet gets one, three writers at a time.
  useEffect(() => {
    const need = ticked.filter((p) => !rowOf(p).scene && rowOf(p).state === 'idle' && !tried.current.has(p.url)).map((p) => p.url);
    for (const u of need) tried.current.add(u);
    if (need.length) writeScenes(need);
  }, [picks, rows]);

  // A different way of showing the product means different scenes, for rows not yet made.
  const firstShown = useRef(true);
  useEffect(() => {
    if (firstShown.current) { firstShown.current = false; return; }
    const list = picksRef.current.filter((p) => p.url && rowOf(p).use && !['done', 'making', 'waiting'].includes(rowOf(p).state)).map((p) => p.url);
    if (list.length) writeScenes(list);
  }, [shown]);

  async function makeAll() {
    setError('');
    const list = ticked.filter((p) => !['making', 'waiting'].includes(rowOf(p).state));
    if (!list.length) return;
    if (list.length > MAX_SHOTS) return setError('Up to ' + MAX_SHOTS + ' shots at a time. Untick ' + (list.length - MAX_SHOTS) + '.');
    const empty = list.find((p) => !rowOf(p).scene.trim());
    if (empty) return setError('Write a scene for ' + (empty.title || 'every ticked picture') + '.');
    for (const p of list) update(p.url, { state: 'waiting', error: '' });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (next < list.length) await makeOne(list[next++]);
    }));
  }

  async function makeOne(p) {
    const r = rowsRef.current[p.url] || {};
    const product = byHandle[p.handle] || {};
    update(p.url, { state: 'making', error: '' });
    try {
      const { ok, status, d } = await mockupsPost({ action: 'generate', brand, imageUrl: p.url, scene: r.scene, size, quality: 'high',
        variationIndex: shown === 'model' || shown === 'room' ? 0 : undefined, notes: presentationLine(shown),
        side: p.side === 'back' || p.side === 'front' ? p.side : undefined,
        product: { id: product.id, title: p.title || product.title, handle: p.handle, color: p.side === 'back' ? 'Back' : null } });
      if (status === 403) return update(p.url, { state: 'failed', error: 'Making lifestyle shots needs the Mockups area on your role.' });
      if (!ok || !d.draft) return update(p.url, { state: 'failed', error: d.error || 'The image could not be made.' });
      update(p.url, { state: 'done' });
      // Into the ad in this picture's place; the made shot's own row starts unticked.
      const res = await onMade(p, { id: d.draft.id, url: d.draft.url, side: p.side || null });
      if (res && res.error) update(p.url, { state: 'done', error: 'Saved to Drafts, but not put in the ad: ' + res.error + ' Pick it on the left.' });
    } catch {
      update(p.url, { state: 'failed', error: 'Request failed.' });
    }
  }

  const status = (r, p) => {
    if (!r.use && r.state === 'idle') return 'Used in the ad as it is.';
    return {
      idle: r.scene ? 'Ready' : '', queued: 'Writing a scene...', writing: 'Writing a scene...',
      waiting: 'Waiting its turn', making: 'Making it (about a minute)...', failed: 'Failed: ' + r.error, done: 'Made and put in the ad.',
    }[r.state] || '';
  };

  if (!picks.length) {
    return (
      <div className="card">
        <div className="card-label">Lifestyle shots</div>
        <div className="ledger-note">Pick the products and pictures for the ad on the left first. They are listed here, and you choose which ones get a new lifestyle shot.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="mk-job-head" style={{ marginBottom: open ? 10 : 0 }}>
        <div className="mk-job-title">
          <div className="card-label" style={{ marginBottom: 2 }}>Lifestyle shots</div>
          <div className="ledger-note">
            {ticked.length ? ticked.length + ' of ' + usable.length + ' picked pictures ticked for a new shot.' : 'Every picked picture is used as it is.'}
            {' '}The same picks carry to the carousel, video and image ad.
          </div>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <>
          <div className="field-row">
            <label className="field">
              <span>Shown</span>
              <select className="input" value={shown} onChange={(e) => setShown(e.target.value)} disabled={running}>
                {Object.entries(PRESENTATIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Shape</span>
              <select className="input" value={size} onChange={(e) => setSize(e.target.value)} disabled={running}>
                <option value="portrait">Portrait</option>
                <option value="square">Square</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
          </div>

          {picks.map((p, i) => {
            const r = rowOf(p);
            const locked = ['making', 'waiting'].includes(r.state);
            return (
              <div key={p.url || i} className="ap-batch-row">
                <label className="check ap-batch-use" title={p.url ? 'Make a new lifestyle shot from this picture' : ''}>
                  <input type="checkbox" checked={Boolean(p.url && r.use && r.state !== 'done')} disabled={!p.url || locked || r.state === 'done'}
                    onChange={(e) => update(p.url, { use: e.target.checked, error: '' })} aria-label={'New lifestyle shot of ' + (p.title || 'this picture')} />
                </label>
                <img src={p.thumb || p.url} alt="" />
                <div className="ap-batch-body">
                  <div className="li-name" style={{ fontSize: 13 }}>
                    {p.title || 'Picture ' + (i + 1)}
                    <span className="li-sub"> · {p.lifestyle ? 'lifestyle shot' : 'product shot'}{p.side === 'back' ? ', back' : ''}{p.made ? ', made here' : ''}</span>
                  </div>
                  {!p.url && <div className="ap-batch-status">An upload: shots are made from store or library pictures only.</div>}
                  {p.url && r.use && r.state !== 'done' && (
                    <textarea className="input" rows={3} value={r.scene} disabled={locked}
                      placeholder={WRITING.includes(r.state) ? 'Claude is writing a scene...' : 'Describe the setting'}
                      onChange={(e) => update(p.url, { scene: e.target.value })} />
                  )}
                  {p.url && (
                    <div className={'ap-batch-status' + (r.state === 'failed' || r.error ? ' bad' : '')}>
                      {status(r, p)}{r.state !== 'failed' && r.error ? ' ' + r.error : ''}
                    </div>
                  )}
                  {p.url && r.use && !['done', 'making', 'waiting'].includes(r.state) && (
                    <div className="reply-actions">
                      <button type="button" className="link-inline" onClick={() => writeScenes([p.url])} disabled={WRITING.includes(r.state)}>Another scene</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div className="reply-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" onClick={makeAll} disabled={running || scenesBusy || ticked.length === 0}>
              {running ? 'Making lifestyle shots...' : ticked.length === 0 ? 'Nothing ticked' : 'Make ' + ticked.length + ' lifestyle shot' + (ticked.length === 1 ? '' : 's')}
            </button>
          </div>
          {error && <div className="login-error" style={{ marginTop: 8 }}>{error}</div>}
          <div className="ledger-note" style={{ marginTop: 8 }}>
            {ticked.length > 0 ? ticked.length + ' paid image' + (ticked.length === 1 ? '' : 's') + ' at high quality, about $' + (ticked.length * SHOT_COST).toFixed(2) + ', two at a time. ' : ''}
            Each new shot replaces its product shot in the ad, is saved to Drafts and print-checked after; the product shot stays on the left if you want it back.
          </div>
        </>
      )}
    </div>
  );
}
