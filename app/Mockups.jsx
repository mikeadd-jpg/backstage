'use client';
// Pick a live product from one of the Shopify stores, drop it into a scene, review the
// result, and only then attach it to the product. Generated images are held here in the
// browser and nowhere else, so leaving the tab discards anything not attached.
import { useEffect, useMemo, useState } from 'react';

const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const SIZE_LABELS = { portrait: 'Portrait', square: 'Square', landscape: 'Landscape' };

export default function Mockups() {
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [scenes, setScenes] = useState({});
  const [defaults, setDefaults] = useState({});
  const [metaAccounts, setMetaAccounts] = useState({});   // brand -> ad account id, or null
  const [sizes, setSizes] = useState(['portrait', 'square', 'landscape']);
  const [ready, setReady] = useState(true);

  const [cache, setCache] = useState({});          // brand -> products
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(null);

  const [notes, setNotes] = useState('');
  const [size, setSize] = useState('portrait');
  const [quality, setQuality] = useState('medium');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [shots, setShots] = useState([]);          // newest first, this session only

  useEffect(() => {
    fetch('/api/mockups').then((r) => r.json()).then((d) => {
      const bs = d.brands || [];
      setBrands(bs);
      setScenes(d.scenes || {});
      setDefaults(d.defaults || {});
      setMetaAccounts(d.meta || {});
      setSizes(d.sizes || sizes);
      setReady(d.ready !== false);
      if (bs.length) setBrand(bs[0].key);
    }).catch(() => setError('Could not load the stores.'));
  }, []);

  useEffect(() => {
    if (!brand || cache[brand]) return;
    setLoadingList(true); setError('');
    fetch('/api/mockups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', brand }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setError(d.error || 'Could not load products.');
        else setCache((c) => ({ ...c, [brand]: d.products || [] }));
      })
      .catch(() => setError('Could not load products.'))
      .finally(() => setLoadingList(false));
  }, [brand]);

  const products = cache[brand] || [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.title.toLowerCase().includes(q));
  }, [products, search]);

  const scene = scenes[brand] || '';
  const isDefault = scene.trim() === (defaults[brand] || '').trim();

  function setScene(text) {
    setScenes((s) => ({ ...s, [brand]: text }));
    setSavedNote('');
  }

  async function saveScene() {
    setSavedNote(''); setError('');
    const res = await fetch('/api/mockups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save-scene', brand, scene }),
    });
    const d = await res.json();
    if (!res.ok) setError(d.error || 'Could not save the scene.');
    else setSavedNote('Saved as the default for this store.');
  }

  async function generate() {
    setError(''); setSavedNote('');
    if (!picked) return setError('Pick a product first.');
    if (!scene.trim()) return setError('Write a scene for the shot.');
    setBusy(true);
    try {
      const res = await fetch('/api/mockups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate', brand, imageUrl: picked.image, scene, notes, size, quality,
        }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Generation failed.');
      else {
        setShots((s) => [{
          key: Date.now(), b64: d.b64, prompt: d.prompt || '', product: picked,
          brand, dest: {},
        }, ...s]);
      }
    } catch { setError('Something went wrong. Try again.'); }
    setBusy(false);
  }

  function mark(key, dest, state, message) {
    setShots((s) => s.map((sh) => (sh.key === key
      ? { ...sh, dest: { ...sh.dest, [dest]: { state, message: message || '' } } }
      : sh)));
  }

  // One destination at a time. Shopify and Meta are independent, so a failure in one
  // never stops the other and each keeps its own error.
  async function send(shot, dest) {
    mark(shot.key, dest, 'sending');
    const payload = dest === 'shopify'
      ? {
          action: 'attach', brand: shot.brand, productId: shot.product.id, b64: shot.b64,
          alt: shot.product.title + ' lifestyle',
        }
      : {
          action: 'attach-meta', brand: shot.brand, b64: shot.b64,
          name: shot.product.handle + '-lifestyle.png',
        };
    try {
      const res = await fetch('/api/mockups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) { mark(shot.key, dest, 'failed', d.error || 'Failed.'); return false; }
      mark(shot.key, dest, 'done', d.hash ? 'image hash ' + d.hash : '');
      return true;
    } catch {
      mark(shot.key, dest, 'failed', 'Request failed.');
      return false;
    }
  }

  async function sendEverywhere(shot) {
    await send(shot, 'shopify');
    if (metaAccounts[shot.brand]) await send(shot, 'meta');
  }

  const destState = (shot, dest) => (shot.dest || {})[dest] || {};
  const busyDest = (shot, dest) => destState(shot, dest).state === 'sending';
  const doneDest = (shot, dest) => destState(shot, dest).state === 'done';

  return (
    <div className="pane">
      <div className="pane-head">Lifestyle Mockups</div>
      <p className="pane-sub">
        Pick a live product, put it in a scene, then attach the result to that product in Shopify.
        Images are held in this tab only: leaving the page throws away anything you have not attached.
      </p>

      {!ready && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span>
          <span>OPENAI_API_KEY is not set, so generation will fail. Add it in Vercel and redeploy.</span>
        </div>
      )}

      <div className="card">
        <div className="field-row">
          <label className="field">
            <span>Store</span>
            <select className="input" value={brand} onChange={(e) => { setBrand(e.target.value); setPicked(null); setSearch(''); }}>
              {brands.length === 0 && <option value="">No stores configured</option>}
              {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="filter by title" />
          </label>
        </div>

        <div className="field">
          <span>
            Active products
            <span className="acc-count" style={{ marginLeft: 8 }}>
              {loadingList ? 'loading...' : filtered.length + ' shown'}
            </span>
          </span>
          <div className="mk-grid">
            {!loadingList && filtered.length === 0 && (
              <div className="ledger-note">No active products with images.</div>
            )}
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                className={'mk-item' + (picked && picked.id === p.id ? ' picked' : '')}
                onClick={() => setPicked(p)}
                title={p.title}
              >
                <img className="mk-thumb" src={p.image} alt="" loading="lazy" />
                <span className="mk-title">{p.title}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-label">The shot</div>

        <label className="field">
          <span>Scene for {brands.find((b) => b.key === brand)?.name || 'this store'}</span>
          <textarea className="textarea" rows={5} value={scene} onChange={(e) => setScene(e.target.value)} />
        </label>
        <div className="reply-actions" style={{ marginBottom: 14 }}>
          <button className="btn btn-ghost" type="button" onClick={saveScene} disabled={!brand}>Save as default</button>
          <button className="btn btn-ghost" type="button" onClick={() => setScene(defaults[brand] || '')} disabled={isDefault}>Reset</button>
          {savedNote && <span className="confidence">{savedNote}</span>}
        </div>

        <label className="field">
          <span>Notes for this shot (optional)</span>
          <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. shoot it outdoors, model facing away" />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Shape</span>
            <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
              {sizes.map((s) => <option key={s} value={s}>{SIZE_LABELS[s] || s}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Quality</span>
            <select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}>
              {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          </label>
        </div>
        <div className="ledger-note">Higher quality takes longer and costs more. There is 300 seconds of headroom, so max is reachable, but you will wait for it.</div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary" onClick={generate} disabled={busy || !picked}>
          {busy ? 'Generating...' : picked ? 'Generate a mockup' : 'Pick a product first'}
        </button>
        {picked && <div className="ledger-note" style={{ marginTop: 8 }}>Using: {picked.title}</div>}
      </div>

      {shots.map((shot) => (
        <div className="card" key={shot.key}>
          <div className="card-label">{shot.product.title}</div>
          <div className="mk-compare">
            <figure>
              <img src={shot.product.image} alt="" />
              <figcaption>Store image</figcaption>
            </figure>
            <figure>
              <img src={'data:image/png;base64,' + shot.b64} alt="" />
              <figcaption>Generated</figcaption>
            </figure>
          </div>

          <div className="flag" style={{ marginTop: 12 }}>
            <span className="ico">&#9873;</span>
            <span>Check the artwork against the store image before attaching, especially any lettering. The model redraws the whole frame.</span>
          </div>

          {shot.prompt && (
            <details className="mk-prompt">
              <summary>Prompt that produced this</summary>
              <pre>{shot.prompt}</pre>
            </details>
          )}

          <div className="reply-actions" style={{ marginTop: 14 }}>
            <a
              className="btn btn-ghost"
              href={'data:image/png;base64,' + shot.b64}
              download={shot.product.handle + '-lifestyle.png'}
            >Download</a>

            <button
              className={'btn btn-ghost' + (doneDest(shot, 'shopify') ? ' copied' : '')}
              onClick={() => send(shot, 'shopify')}
              disabled={busyDest(shot, 'shopify') || doneDest(shot, 'shopify')}
            >
              {busyDest(shot, 'shopify') ? 'Sending...'
                : doneDest(shot, 'shopify') ? 'On the product'
                : 'Send to Shopify'}
            </button>

            <button
              className={'btn btn-ghost' + (doneDest(shot, 'meta') ? ' copied' : '')}
              onClick={() => send(shot, 'meta')}
              disabled={!metaAccounts[shot.brand] || busyDest(shot, 'meta') || doneDest(shot, 'meta')}
              title={metaAccounts[shot.brand]
                ? 'Ad account ' + metaAccounts[shot.brand]
                : 'No Meta ad account configured for this store'}
            >
              {busyDest(shot, 'meta') ? 'Sending...'
                : doneDest(shot, 'meta') ? 'In the ad account'
                : 'Send to Meta'}
            </button>

            <button
              className="btn btn-primary"
              onClick={() => sendEverywhere(shot)}
              disabled={busyDest(shot, 'shopify') || busyDest(shot, 'meta')
                || (doneDest(shot, 'shopify') && (!metaAccounts[shot.brand] || doneDest(shot, 'meta')))}
            >Send everywhere</button>
          </div>

          <div className="mk-dests">
            {['shopify', 'meta'].map((dest) => {
              const st = destState(shot, dest);
              if (!st.state || st.state === 'sending') return null;
              const label = dest === 'shopify' ? 'Shopify' : 'Meta';
              return (
                <div className="mk-dest" key={dest}>
                  <span className="mini-dot" style={{
                    background: st.state === 'done' ? 'var(--green)' : 'var(--red)',
                  }} />
                  <span>{label}: {st.state === 'done' ? (st.message || 'sent') : st.message}</span>
                </div>
              );
            })}
            {!metaAccounts[shot.brand] && (
              <div className="mk-dest">
                <span className="mini-dot" style={{ background: 'var(--faint)' }} />
                <span>Meta: no ad account configured for this store</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
