'use client';
// The Ads tab's "By product" picker: the store's products, filtered by collection and
// sorted by best sellers (units sold, 90 days, from Shopify's sales report), newest or
// name. Opening a product shows every picture there is for it: lifestyle shots already in
// the Meta ad image library, mockups kept in Drafts, and the store's own mockups per
// colour. When none of them will do, a lifestyle shot is made right here through the
// Mockups route (one image, saved to Drafts like any other), so nobody has to leave the
// tab. Picking a picture hands it to the Ads tab (`onPick`), which adds it to whichever
// builder is open; the tab copies it into the ad library first when a carousel needs that.
//
// "Make shots for several products" ticks products instead of opening them and makes one
// lifestyle shot of each from one button (`BatchShots`), the Mockups tab's way: one
// request per shot, two at a time, each product with its own scene written with the
// others' passed along as already used, and a second press retrying only what is missing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PRESENTATIONS, presentationLine } from '../lib/stillPlans.js';

const SORTS = { best: 'Best sellers', new: 'Newest', updated: 'Recently updated', az: 'A to Z' };
const PAGE = 60;
// Spending guard for one press of "Make shots", the same number as MAX_PRODUCTS in
// /api/mockups: each product is one paid image at high quality.
const MAX_BATCH_PRODUCTS = 10;
const SHOT_COST = 0.25;           // high quality, lib/spend.js
const CONCURRENCY = 2;            // as in the Mockups tab: a rate limit is likelier than a speedup past two

// The picture a shot is made from: the back design leads where there is one (shotOf),
// unless the front is asked for.
function sourceImage(product, color, side) {
  const c = (product.colors || []).find((x) => x.name === color) || {};
  return (side === 'back' && product.hasBack && c.back) || c.front || product.image;
}

async function mockupsPost(payload) {
  const res = await fetch('/api/mockups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { ok: res.ok, status: res.status, d: await res.json().catch(() => ({})) };
}

export default function AdProducts({ brand, lib, isPicked, onPick, busy, onDraftMade, initialQuery = '', onUseProduct = null, productNote = null }) {
  const [collection, setCollection] = useState('');
  const [sort, setSort] = useState('best');
  const [q, setQ] = useState(initialQuery);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState(null);           // handle of the product being looked at
  const [batchMode, setBatchMode] = useState(false); // ticking products for several shots at once
  const [rows, setRows] = useState([]);             // BatchShots rows, kept here so opening a product keeps them
  const [note, setNote] = useState('');

  useEffect(() => { setCollection(''); setQ(initialQuery); setOpen(null); setLimit(PAGE); setRows([]); setBatchMode(false); }, [brand]);
  useEffect(() => { if (!lib.sold && sort === 'best') setSort('new'); }, [lib.sold]);

  const products = lib.products || [];
  const collections = useMemo(() => [...new Set(products.flatMap((p) => p.collections || []))].sort((a, b) => a.localeCompare(b)), [products]);
  const shotsFor = useMemo(() => {
    const m = {};
    for (const img of lib.images || []) if (img.handle) (m[img.handle] = m[img.handle] || []).push(img);
    return m;
  }, [lib.images]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = products.filter((p) => (!collection || (p.collections || []).includes(collection)) && (!needle || p.title.toLowerCase().includes(needle)));
    const by = {
      best: (a, b) => (b.sold || 0) - (a.sold || 0) || String(b.createdAt).localeCompare(String(a.createdAt)),
      new: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
      updated: () => 0,                 // the store's own order is most recently updated first
      az: (a, b) => a.title.localeCompare(b.title),
    }[sort];
    return out.slice().sort(by);
  }, [products, collection, q, sort]);

  const product = open ? products.find((p) => p.handle === open) : null;
  const ticked = new Set(rows.map((r) => r.handle));

  function tick(p) {
    setNote('');
    if (ticked.has(p.handle)) {
      const r = rows.find((x) => x.handle === p.handle);
      if (r && r.state === 'making') return;
      return setRows((rs) => rs.filter((x) => x.handle !== p.handle));
    }
    if (rows.length >= MAX_BATCH_PRODUCTS) return setNote('Up to ' + MAX_BATCH_PRODUCTS + ' products at a time. Untick one to add another.');
    const colors = p.colors || [];
    const color = p.defaultColor || (colors[0] && colors[0].name) || '';
    setRows((rs) => [...rs, { handle: p.handle, product: p, color, side: p.hasBack ? 'back' : 'front', scene: '', state: 'new', error: '', result: null }]);
  }

  if (product) {
    return <ProductPictures brand={brand} product={product} shots={shotsFor[product.handle] || []} drafts={(lib.drafts || {})[product.handle] || []}
      isPicked={isPicked} onPick={onPick} busy={busy} onBack={() => setOpen(null)} onDraftMade={onDraftMade} onUseProduct={onUseProduct} note={productNote} />;
  }

  return (
    <>
      <div className="reply-actions" style={{ marginBottom: 8 }}>
        <button type="button" className={'btn ' + (batchMode ? 'btn-primary' : 'btn-ghost')} onClick={() => { setBatchMode((m) => !m); setNote(''); }}>
          {batchMode ? 'Done ticking' : '+ Make shots for several products'}
        </button>
      </div>
      {(batchMode || rows.length > 0) && (
        <BatchShots brand={brand} rows={rows} setRows={setRows} isPicked={isPicked} onPick={onPick} busy={busy} onDraftMade={onDraftMade}
          ticking={batchMode} />
      )}
      {note && <div className="login-error" style={{ marginBottom: 8 }}>{note}</div>}
      <div className="field-row">
        <label className="field">
          <span>Collection</span>
          <select className="input" value={collection} onChange={(e) => { setCollection(e.target.value); setLimit(PAGE); }}>
            <option value="">All products</option>
            {collections.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Sort</span>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
            {Object.entries(SORTS).filter(([k]) => k !== 'best' || lib.sold).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Search products</span>
        <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="product name" />
      </label>
      <div className="mk-picker-head">
        <span>Products</span>
        <span className="acc-count">{list.length} shown{sort === 'best' ? ' · units sold, last 90 days' : ''}</span>
      </div>
      <div className="mk-grid">
        {list.length === 0 && <div className="ledger-note">No products match.</div>}
        {list.slice(0, limit).map((p) => {
          const n = (shotsFor[p.handle] || []).length + ((lib.drafts || {})[p.handle] || []).length;
          const on = ticked.has(p.handle);
          return (
            <button key={p.handle} type="button" className={'mk-item' + (batchMode && on ? ' picked' : '')} title={p.title}
              onClick={() => (batchMode ? tick(p) : setOpen(p.handle))}>
              {batchMode && <span className="ap-tick">{on ? '✓' : ''}</span>}
              <img className="mk-thumb" src={p.image} alt="" loading="lazy" />
              <span className="mk-title">{p.title}</span>
              <span className="ap-meta">
                {p.sold != null ? p.sold + ' sold' : ''}{p.sold != null && ' · '}{n ? n + ' lifestyle' : 'no lifestyle yet'}
              </span>
            </button>
          );
        })}
        {list.length > limit && <button type="button" className="btn btn-ghost" onClick={() => setLimit((l) => l + PAGE)}>Show more</button>}
      </div>
    </>
  );
}

function Pic({ pic, picked, onPick, busy, badge }) {
  return (
    <button type="button" className={'mk-item' + (picked ? ' picked' : '')} onClick={() => onPick(pic)} disabled={busy} title={pic.title}>
      {picked && <span className="ad-pos">✓</span>}
      <img className="mk-thumb" src={pic.thumb || pic.url} alt="" loading="lazy" />
      <span className="mk-title">{pic.label}</span>
      {badge && <span className="ap-meta">{badge}</span>}
    </button>
  );
}

function ProductPictures({ brand, product, shots, drafts, isPicked, onPick, busy, onBack, onDraftMade, onUseProduct, note }) {
  const base = { handle: product.handle, title: product.title, productId: product.id };
  const library = shots.map((img) => ({ ...base, source: 'library', hash: img.hash, url: img.url, name: img.name, width: img.width, height: img.height, label: 'In Meta', lifestyle: true }));
  const kept = drafts.map((d) => ({ ...base, source: 'draft', draftId: d.id, url: d.url, label: (d.color || 'Draft') + (d.favorite ? ' ★' : ''), lifestyle: true, side: d.side || null,
    check: d.check }));
  // Each colour's front, and its back when the design has one.
  const store = (product.colors && product.colors.length ? product.colors : [{ name: '', front: product.image }])
    .flatMap((c) => [
      // The back design first: it leads unless the front is asked for.
      ...(product.hasBack && c.back ? [{ ...base, source: 'store', url: c.back, label: (c.name || 'Store photo') + ' · back', lifestyle: false, side: 'back' }] : []),
      { ...base, source: 'store', url: c.front, label: (c.name || 'Store photo') + (product.hasBack ? ' · front' : ''), lifestyle: false, side: product.hasBack ? 'front' : null },
    ]);
  const [making, setMaking] = useState(false);

  return (
    <div className="ap-product">
      <button type="button" className="link-inline" onClick={onBack}>← All products</button>
      <div className="li-name" style={{ margin: '6px 0 2px' }}>{product.title}</div>
      <div className="ledger-note" style={{ marginBottom: 10 }}>
        {product.sold != null ? product.sold + ' sold in 90 days · ' : ''}{(product.collections || []).slice(0, 3).join(', ')}
      </div>
      {onUseProduct && (
        <div className="reply-actions" style={{ marginBottom: 6 }}>
          <button type="button" className="btn btn-ghost" onClick={() => onUseProduct(product)}>{note && note(product) ? note(product) : '+ Use this product (new shots in the batch)'}</button>
        </div>
      )}

      <div className="mk-picker-head"><span>Lifestyle shots in Meta</span><span className="acc-count">{library.length}</span></div>
      <div className="mk-grid">
        {library.length === 0 && <div className="ledger-note">None in the ad library yet.</div>}
        {library.map((p) => <Pic key={p.hash} pic={p} picked={isPicked(p)} onPick={onPick} busy={busy} />)}
      </div>

      <div className="mk-picker-head"><span>Mockups in Drafts</span><span className="acc-count">{kept.length}</span></div>
      <div className="mk-grid">
        {kept.length === 0 && <div className="ledger-note">None in Drafts.</div>}
        {kept.map((p) => (
          <Pic key={p.draftId} pic={p} picked={isPicked(p)} onPick={onPick} busy={busy}
            badge={p.check ? (p.check.pass ? 'print check ' + p.check.score + '/10' : '⚠ print check ' + p.check.score + '/10') : null} />
        ))}
      </div>

      <div className="mk-picker-head"><span>Store mockups</span><span className="acc-count">{store.length}</span></div>
      <div className="mk-grid">
        {store.map((p) => <Pic key={p.url} pic={p} picked={isPicked(p)} onPick={onPick} busy={busy} />)}
      </div>

      {making ? <MakeShot brand={brand} product={product} onClose={() => setMaking(false)} onMade={(d) => onDraftMade(product.handle, d)} />
        : <button type="button" className="btn btn-primary" style={{ marginTop: 12, width: '100%' }} onClick={() => setMaking(true)}>+ Make a lifestyle shot</button>}
    </div>
  );
}

// One lifestyle shot of this product, made through /api/mockups (the same generator and
// print check as the Mockups tab), landing in Drafts and in the list above.
function MakeShot({ brand, product, onClose, onMade }) {
  const colors = product.colors || [];
  const [color, setColor] = useState(product.defaultColor || (colors[0] && colors[0].name) || '');
  const [scene, setScene] = useState('');
  const [used, setUsed] = useState([]);
  const [writing, setWriting] = useState(false);
  const [size, setSize] = useState('portrait');
  const [shown, setShown] = useState(brand === 'wallspoke' ? 'room' : 'model');
  const [side, setSide] = useState(product.hasBack ? 'back' : 'front');
  const [state, setState] = useState(null);           // null | { busy } | { error } | { done }
  const pick = colors.find((c) => c.name === color) || {};
  const front = (side === 'back' && product.hasBack && pick.back) || pick.front || product.image;

  async function rotate() {
    setWriting(true);
    try {
      const { ok, status, d } = await mockupsPost({ action: 'suggest-scene', brand, product: { title: product.title, productType: product.productType, image: front },
        current: scene, previous: used, presentation: shown });
      if (status === 403) return setState({ error: 'Making mockups needs the Mockups area on your role.' });
      if (!ok) return setState({ error: d.error || 'Could not write a scene.' });
      setScene(d.scene); setUsed((u) => [d.scene, ...u].slice(0, 8));
    } catch { setState({ error: 'Could not write a scene.' }); } finally { setWriting(false); }
  }
  useEffect(() => { rotate(); }, [shown]);

  async function make() {
    setState({ busy: true });
    try {
      const { ok, status, d } = await mockupsPost({ action: 'generate', brand, imageUrl: front, scene, size, quality: 'high',
        variationIndex: shown === 'model' || shown === 'room' ? 0 : undefined, notes: presentationLine(shown), side: product.hasBack ? side : undefined,
        product: { id: product.id, title: product.title, handle: product.handle, color: color + (side === 'back' ? ', back' : '') } });
      if (status === 403) return setState({ error: 'Making mockups needs the Mockups area on your role.' });
      if (!ok || !d.draft) return setState({ error: d.error || 'The image could not be made.' });
      onMade({ id: d.draft.id, url: d.draft.url, color, favorite: false, check: null, at: new Date().toISOString() });
      setState({ done: true });
    } catch { setState({ error: 'Request failed.' }); }
  }

  return (
    <div className="ap-make">
      <div className="card-label" style={{ marginBottom: 8 }}>Make a lifestyle shot</div>
      <div className="field-row">
        {colors.length > 0 && (
          <label className="field">
            <span>Colour</span>
            <select className="input" value={color} onChange={(e) => setColor(e.target.value)}>
              {colors.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
        )}
        {product.hasBack && (
          <label className="field">
            <span>Side</span>
            <select className="input" value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="back">Back design</option>
              <option value="front">Front design</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Shown</span>
          <select className="input" value={shown} onChange={(e) => setShown(e.target.value)}>
            {Object.entries(PRESENTATIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Shape</span>
          <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
            <option value="portrait">Portrait</option>
            <option value="square">Square</option>
            <option value="landscape">Landscape</option>
          </select>
        </label>
      </div>
      <img className="ap-front" src={front} alt="" />
      <label className="field">
        <span>Scene</span>
        <textarea className="input" rows={4} value={scene} onChange={(e) => setScene(e.target.value)} placeholder={writing ? 'Claude is writing a scene...' : 'Describe the setting'} />
      </label>
      <div className="reply-actions">
        <button className="btn btn-primary" type="button" onClick={make} disabled={!scene.trim() || (state && state.busy)}>
          {state && state.busy ? 'Making it (about a minute)...' : state && state.done ? 'Make another' : 'Make it'}
        </button>
        <button className="btn btn-ghost" type="button" onClick={rotate} disabled={writing || (state && state.busy)}>{writing ? 'Writing...' : 'Another scene'}</button>
        <button className="btn btn-ghost" type="button" onClick={onClose} disabled={state && state.busy}>Close</button>
      </div>
      {state && state.error && <div className="login-error" style={{ marginTop: 8 }}>{state.error}</div>}
      {state && state.done && <div className="ledger-note" style={{ marginTop: 8 }}>Made and saved to Drafts. It is under Mockups in Drafts above; check the print before you use it.</div>}
      <div className="ledger-note" style={{ marginTop: 8 }}>One image at high quality, about $0.25. The print check runs after.</div>
    </div>
  );
}

// One lifestyle shot for each ticked product, from one button. Each product gets its own
// scene from Claude (suggestScene, looking at the product), written three at a time with
// every other row's scene passed as "already used" so ten products get ten settings. Then
// one /api/mockups 'generate' per product, two at a time: the server adds the store's
// models and notes, saves each to Drafts and runs the print check after. A failed shot is
// reported on its own row and the rest carry on; pressing again makes only the rows
// without a shot. Finished shots are pickable for the ad in the row itself.
function BatchShots({ brand, rows, setRows, isPicked, onPick, busy, onDraftMade, ticking }) {
  const [shown, setShown] = useState(brand === 'wallspoke' ? 'room' : 'model');
  const [size, setSize] = useState('portrait');
  const [error, setError] = useState('');
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const writing = useRef(new Set());

  const update = (handle, patch) => setRows((rs) => rs.map((r) => (r.handle === handle ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)));

  async function writeScene(handle) {
    const r = rowsRef.current.find((x) => x.handle === handle);
    if (!r || writing.current.has(handle)) return;
    writing.current.add(handle);
    update(handle, { state: r.state === 'done' ? 'done' : 'writing', error: '' });
    const previous = rowsRef.current.filter((x) => x.handle !== handle).flatMap((x) => [x.scene, ...(x.used || [])]).filter(Boolean);
    try {
      const { ok, status, d } = await mockupsPost({ action: 'suggest-scene', brand,
        product: { title: r.product.title, productType: r.product.productType, image: sourceImage(r.product, r.color, r.side) },
        current: r.scene, previous: Array.from(new Set([...(r.used || []), ...previous])).slice(0, 20), presentation: shown });
      if (status === 403) return setError('Making mockups needs the Mockups area on your role.');
      if (!ok) return update(handle, (x) => ({ state: x.state === 'done' ? 'done' : 'ready', error: (d.error || 'Could not write a scene.') + ' Write one in the box.' }));
      update(handle, (x) => ({ scene: d.scene, used: [d.scene, ...(x.used || [])].slice(0, 6), state: x.state === 'done' ? 'done' : 'ready' }));
    } catch {
      update(handle, (x) => ({ state: x.state === 'done' ? 'done' : 'ready', error: 'Could not write a scene. Write one in the box.' }));
    } finally {
      writing.current.delete(handle);
    }
  }

  // New rows get a scene as they are ticked, three writers at a time.
  useEffect(() => {
    const fresh = rows.filter((r) => r.state === 'new').map((r) => r.handle);
    if (!fresh.length) return;
    setRows((rs) => rs.map((r) => (fresh.includes(r.handle) ? { ...r, state: 'queued' } : r)));
    let next = 0;
    Promise.all(Array.from({ length: Math.min(3, fresh.length) }, async () => {
      while (next < fresh.length) await writeScene(fresh[next++]);
    }));
  }, [rows]);

  // Changing how the product is shown rewrites every scene that has no shot yet.
  const firstShown = useRef(true);
  useEffect(() => {
    if (firstShown.current) { firstShown.current = false; return; }
    const list = rowsRef.current.filter((r) => !['done', 'making', 'waiting'].includes(r.state)).map((r) => r.handle);
    let next = 0;
    Promise.all(Array.from({ length: Math.min(3, list.length) }, async () => {
      while (next < list.length) await writeScene(list[next++]);
    }));
  }, [shown]);

  // Read off the rows rather than kept as state: opening a product unmounts this panel
  // while its requests carry on, and on return the button must still know a run is going.
  const running = rows.some((r) => r.state === 'making' || r.state === 'waiting');
  const todo = rows.filter((r) => r.state !== 'done');
  const scenesBusy = rows.some((r) => ['new', 'queued', 'writing'].includes(r.state));

  async function makeAll() {
    setError('');
    // Pinned at the start; only rows without a shot, so a second press retries just those.
    const list = rowsRef.current.filter((r) => !['done', 'making', 'waiting'].includes(r.state));
    if (!list.length) return;
    const empty = list.find((r) => !r.scene.trim());
    if (empty) return setError('Write a scene for ' + empty.product.title + '.');
    for (const r of list) update(r.handle, { state: 'waiting', error: '' });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
      while (next < list.length) {
        const r = rowsRef.current.find((x) => x.handle === list[next].handle) || list[next];
        next++;
        await makeOne(r);
      }
    }));
  }

  async function makeOne(r) {
    const p = r.product;
    update(r.handle, { state: 'making', error: '' });
    try {
      const { ok, status, d } = await mockupsPost({ action: 'generate', brand, imageUrl: sourceImage(p, r.color, r.side), scene: r.scene, size, quality: 'high',
        variationIndex: shown === 'model' || shown === 'room' ? 0 : undefined, notes: presentationLine(shown), side: p.hasBack ? r.side : undefined,
        product: { id: p.id, title: p.title, handle: p.handle, color: (r.color || '') + (r.side === 'back' ? (r.color ? ', back' : 'Back') : '') || null } });
      if (status === 403) return update(r.handle, { state: 'failed', error: 'Making mockups needs the Mockups area on your role.' });
      if (!ok || !d.draft) return update(r.handle, { state: 'failed', error: d.error || 'The image could not be made.' });
      const made = { id: d.draft.id, url: d.draft.url, color: r.color, side: p.hasBack ? r.side : null, favorite: false, check: null, at: new Date().toISOString() };
      onDraftMade(p.handle, made);
      update(r.handle, { state: 'done', result: made });
    } catch {
      update(r.handle, { state: 'failed', error: 'Request failed.' });
    }
  }

  const status = (r) => ({
    new: 'Writing a scene...', queued: 'Writing a scene...', writing: 'Writing a scene...', ready: 'Ready',
    waiting: 'Waiting its turn', making: 'Making it (about a minute)...', failed: 'Failed: ' + r.error, done: 'Made and saved to Drafts. Tap it to use it in the ad.',
  }[r.state] || '');

  return (
    <div className="ap-batch">
      <div className="card-label" style={{ marginBottom: 6 }}>Lifestyle shots for several products</div>
      <div className="ledger-note" style={{ marginBottom: 8 }}>
        {ticking ? 'Tick up to ' + MAX_BATCH_PRODUCTS + ' products below. ' : ''}Each gets its own scene; read them, change any, then make them all at once.
      </div>
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

      {rows.length === 0 && <div className="ledger-note">No products ticked yet.</div>}
      {rows.map((r) => {
        const p = r.product;
        const colors = p.colors || [];
        const locked = r.state === 'making' || r.state === 'waiting' || r.state === 'done';
        const pic = r.result && { handle: p.handle, title: p.title, productId: p.id, source: 'draft', draftId: r.result.id, url: r.result.url,
          label: r.result.color || 'Lifestyle', lifestyle: true, side: r.result.side || null };
        return (
          <div key={r.handle} className="ap-batch-row">
            <img src={sourceImage(p, r.color, r.side)} alt="" />
            <div className="ap-batch-body">
              <div className="li-name" style={{ fontSize: 13 }}>{p.title}</div>
              {(colors.length > 0 || p.hasBack) && (
                <div className="field-row">
                  {colors.length > 0 && (
                    <label className="field">
                      <span>Colour</span>
                      <select className="input" value={r.color} disabled={locked} onChange={(e) => update(r.handle, { color: e.target.value })}>
                        {colors.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                      </select>
                    </label>
                  )}
                  {p.hasBack && (
                    <label className="field">
                      <span>Side</span>
                      <select className="input" value={r.side} disabled={locked} onChange={(e) => update(r.handle, { side: e.target.value })}>
                        <option value="back">Back design</option>
                        <option value="front">Front design</option>
                      </select>
                    </label>
                  )}
                </div>
              )}
              {!pic && (
                <textarea className="input" rows={3} value={r.scene} disabled={locked}
                  placeholder={['new', 'queued', 'writing'].includes(r.state) ? 'Claude is writing a scene...' : 'Describe the setting'}
                  onChange={(e) => update(r.handle, { scene: e.target.value })} />
              )}
              <div className={'ap-batch-status' + (r.state === 'failed' || r.error ? ' bad' : '')}>
                {status(r)}{r.state !== 'failed' && r.error ? ' ' + r.error : ''}
              </div>
              {pic && (
                <div className="ap-batch-result">
                  <Pic pic={pic} picked={isPicked(pic)} onPick={onPick} busy={busy} badge="print check runs after" />
                </div>
              )}
              <div className="reply-actions">
                {!pic && (
                  <button type="button" className="link-inline" onClick={() => writeScene(r.handle)}
                    disabled={locked || ['new', 'queued', 'writing'].includes(r.state)}>Another scene</button>
                )}
                {r.state !== 'making' && r.state !== 'waiting' && (
                  <button type="button" className="link-inline" onClick={() => setRows((rs) => rs.filter((x) => x.handle !== r.handle))}>
                    {pic ? 'Clear' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {rows.length > 0 && (
        <>
          <div className="reply-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-primary" onClick={makeAll} disabled={running || scenesBusy || todo.length === 0}>
              {running ? 'Making ' + rows.filter((r) => r.state === 'done').length + ' of ' + rows.length + '...'
                : todo.length === 0 ? 'All made'
                : rows.some((r) => r.state === 'done' || r.state === 'failed') ? 'Make the ' + todo.length + ' missing'
                : 'Make ' + todo.length + ' lifestyle shot' + (todo.length === 1 ? '' : 's')}
            </button>
            {!running && rows.every((r) => r.state === 'done' || r.state === 'ready' || r.state === 'failed') && (
              <button type="button" className="btn btn-ghost" onClick={() => setRows([])}>Clear all</button>
            )}
          </div>
          {error && <div className="login-error" style={{ marginTop: 8 }}>{error}</div>}
          <div className="ledger-note" style={{ marginTop: 8 }}>
            {todo.length > 0
              ? todo.length + ' paid image' + (todo.length === 1 ? '' : 's') + ' at high quality, about $' + (todo.length * SHOT_COST).toFixed(2) + ', two at a time. '
              : ''}
            Each is saved to Drafts and print-checked after; check the print before you use it.
          </div>
        </>
      )}
    </div>
  );
}
