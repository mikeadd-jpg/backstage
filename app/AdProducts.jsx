'use client';
// The Ads tab's "By product" picker: the store's products, filtered by collection and
// sorted by best sellers (units sold, 90 days, from Shopify's sales report), newest or
// name. Opening a product shows every picture there is for it: lifestyle shots already in
// the Meta ad image library, mockups kept in Drafts, and the store's own mockups per
// colour. When none of them will do, a lifestyle shot is made right here through the
// Mockups route (one image, saved to Drafts like any other), so nobody has to leave the
// tab. Picking a picture hands it to the Ads tab (`onPick`), which adds it to whichever
// builder is open; the tab copies it into the ad library first when a carousel needs that.
import { useEffect, useMemo, useState } from 'react';

const SORTS = { best: 'Best sellers', new: 'Newest', updated: 'Recently updated', az: 'A to Z' };
const PAGE = 60;

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

  useEffect(() => { setCollection(''); setQ(initialQuery); setOpen(null); setLimit(PAGE); }, [brand]);
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

  if (product) {
    return <ProductPictures brand={brand} product={product} shots={shotsFor[product.handle] || []} drafts={(lib.drafts || {})[product.handle] || []}
      isPicked={isPicked} onPick={onPick} busy={busy} onBack={() => setOpen(null)} onDraftMade={onDraftMade} onUseProduct={onUseProduct} note={productNote} />;
  }

  return (
    <>
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
          return (
            <button key={p.handle} type="button" className="mk-item" onClick={() => setOpen(p.handle)} title={p.title}>
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
  const kept = drafts.map((d) => ({ ...base, source: 'draft', draftId: d.id, url: d.url, label: (d.color || 'Draft') + (d.favorite ? ' ★' : ''), lifestyle: true,
    check: d.check }));
  const store = (product.colors && product.colors.length ? product.colors : [{ name: '', front: product.image }])
    .map((c) => ({ ...base, source: 'store', url: c.front, label: c.name || 'Store photo', lifestyle: false }));
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
  const [state, setState] = useState(null);           // null | { busy } | { error } | { done }
  const front = (colors.find((c) => c.name === color) || {}).front || product.image;

  async function rotate() {
    setWriting(true);
    try {
      const { ok, status, d } = await mockupsPost({ action: 'suggest-scene', brand, product: { title: product.title, productType: product.productType, image: front },
        current: scene, previous: used });
      if (status === 403) return setState({ error: 'Making mockups needs the Mockups area on your role.' });
      if (!ok) return setState({ error: d.error || 'Could not write a scene.' });
      setScene(d.scene); setUsed((u) => [d.scene, ...u].slice(0, 8));
    } catch { setState({ error: 'Could not write a scene.' }); } finally { setWriting(false); }
  }
  useEffect(() => { rotate(); }, []);

  async function make() {
    setState({ busy: true });
    try {
      const { ok, status, d } = await mockupsPost({ action: 'generate', brand, imageUrl: front, scene, size, quality: 'high', variationIndex: 0,
        product: { id: product.id, title: product.title, handle: product.handle, color } });
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
