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
  const [metaToken, setMetaToken] = useState(true);       // META_ACCESS_TOKEN present at all
  const [canva, setCanva] = useState({ configured: true, connected: false });
  const [sizes, setSizes] = useState(['portrait', 'square', 'landscape']);
  const [ready, setReady] = useState(true);

  const [cache, setCache] = useState({});          // brand -> products
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(null);

  const [notes, setNotes] = useState('');
  const [size, setSize] = useState('portrait');
  const [quality, setQuality] = useState('medium');

  const [count, setCount] = useState(5);                  // shots per batch
  const [maxBatch, setMaxBatch] = useState(6);
  const [variations, setVariations] = useState({});       // brand -> ordered shot list
  const [done, setDone] = useState(0);                    // completed in the running batch
  const [failures, setFailures] = useState([]);           // per-image, never fatal
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [rotating, setRotating] = useState(false);
  const [seenScenes, setSeenScenes] = useState({});      // brand -> scenes shown this session
  const [shots, setShots] = useState([]);          // newest first, this session only

  useEffect(() => {
    fetch('/api/mockups').then((r) => r.json()).then((d) => {
      const bs = d.brands || [];
      setBrands(bs);
      setScenes(d.scenes || {});
      setDefaults(d.defaults || {});
      setVariations(d.variations || {});
      if (d.maxBatch) setMaxBatch(d.maxBatch);
      setMetaAccounts(d.meta || {});
      setMetaToken(d.metaToken !== false);
      if (d.canva) setCanva(d.canva);
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

  // Claude writes a new scene for the picked product. Everything already shown for this
  // store this session goes along as "already used", so pressing it again moves on rather
  // than circling back. Nothing is saved until "Save as default".
  async function rotateScene() {
    setError(''); setSavedNote(''); setRotating(true);
    const previous = seenScenes[brand] || [];
    try {
      const res = await fetch('/api/mockups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'suggest-scene', brand, product: picked, current: scene, previous }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || 'Could not write a new scene.'); return; }
      setSeenScenes((m) => ({ ...m, [brand]: [scene, ...previous].filter(Boolean).slice(0, 8) }));
      setScene(d.scene);
    } catch {
      setError('Could not write a new scene.');
    } finally {
      setRotating(false);
    }
  }

  // One request per image. A batch is a client-side loop, not a server-side one, so a
  // slow or failed shot cannot take the others with it and results appear as they land.
  async function generateOne(index, product) {
    try {
      const res = await fetch('/api/mockups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate', brand, imageUrl: product.image, scene, notes, size, quality,
          variationIndex: index,
        }),
      });
      const d = await res.json();
      if (!res.ok) return { ok: false, index, error: d.error || 'Generation failed.' };
      setShots((s) => [{
        key: String(Date.now()) + '-' + index, b64: d.b64, prompt: d.prompt || '',
        variation: d.variation || '', product, brand, dest: {},
      }, ...s]);
      return { ok: true };
    } catch {
      return { ok: false, index, error: 'Request failed.' };
    }
  }

  async function generate() {
    setError(''); setSavedNote(''); setFailures([]); setDone(0);
    if (!picked) return setError('Pick a product first.');
    if (!scene.trim()) return setError('Write a scene for the shot.');
    setBusy(true);

    const product = picked;          // pinned, so changing the selection mid-batch is safe
    const total = Math.max(1, Math.min(count, maxBatch));
    const fails = [];
    let next = 0;
    let finished = 0;

    // Two at a time. Five parallel image calls invite a rate limit and buy little over
    // two, while running them one by one makes a batch of five a five minute wait.
    const CONCURRENCY = 2;
    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (next < total) {
        const index = next++;
        const r = await generateOne(index, product);
        if (!r.ok) fails.push(r);
        finished++;
        setDone(finished);
        setFailures([...fails]);
      }
    });
    await Promise.all(workers);

    setBusy(false);
  }

  function mark(key, dest, state, message, extra) {
    setShots((s) => s.map((sh) => (sh.key === key
      ? { ...sh, dest: { ...sh.dest, [dest]: { ...sh.dest[dest], ...extra, state, message: message || '' } } }
      : sh)));
  }

  async function post(payload) {
    const res = await fetch('/api/mockups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, d: await res.json() };
  }

  // Main image. If this shot is already on the product as a secondary image, it is moved
  // to the front rather than uploaded twice. Otherwise it is uploaded and moved in one go,
  // and a failed move still records the upload so a retry only has to move it.
  async function sendMain(shot) {
    mark(shot.key, 'main', 'sending');
    const mediaId = destState(shot, 'shopify').mediaId;
    try {
      if (mediaId) {
        const { ok, d } = await post({ action: 'make-main', brand: shot.brand, productId: shot.product.id, mediaId });
        if (!ok) return mark(shot.key, 'main', 'failed', d.error || 'Failed.');
        return mark(shot.key, 'main', 'done', 'now the main image');
      }
      const { ok, d } = await post({
        action: 'attach', brand: shot.brand, productId: shot.product.id, b64: shot.b64,
        alt: shot.product.title + ' lifestyle', main: true,
      });
      if (!ok) return mark(shot.key, 'main', 'failed', d.error || 'Failed.');
      mark(shot.key, 'shopify', 'done', '', { mediaId: d.id });
      if (d.mainError) return mark(shot.key, 'main', 'failed', 'Added to the product, but not moved to the front: ' + d.mainError);
      mark(shot.key, 'main', 'done', 'now the main image');
    } catch {
      mark(shot.key, 'main', 'failed', 'Request failed.');
    }
  }

  // One destination at a time. Shopify, Meta and Canva are independent, so a failure in
  // one never stops the others and each keeps its own error.
  async function send(shot, dest) {
    mark(shot.key, dest, 'sending');
    const payload = dest === 'shopify'
      ? {
          action: 'attach', brand: shot.brand, productId: shot.product.id, b64: shot.b64,
          alt: shot.product.title + ' lifestyle',
        }
      : {
          action: dest === 'canva' ? 'attach-canva' : 'attach-meta', brand: shot.brand, b64: shot.b64,
          name: shot.product.handle + '-lifestyle.png',
        };
    try {
      const res = await fetch('/api/mockups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) { mark(shot.key, dest, 'failed', d.error || 'Failed.'); return false; }
      const message = d.hash ? 'image hash ' + d.hash
        : dest === 'canva' ? (d.moveError || 'in the brand folder')
        : '';
      const extra = dest === 'shopify' ? { mediaId: d.id }
        : dest === 'canva' ? { folderUrl: d.folderUrl }
        : undefined;
      mark(shot.key, dest, 'done', message, extra);
      return true;
    } catch {
      mark(shot.key, dest, 'failed', 'Request failed.');
      return false;
    }
  }

  async function sendEverywhere(shot) {
    await send(shot, 'shopify');
    if (metaReady(shot.brand)) await send(shot, 'meta');
    if (canva.connected) await send(shot, 'canva');
  }

  // Both halves have to be present. Kept as one helper so the button, the "everywhere"
  // path and the status line cannot drift apart on what "ready" means.
  const metaReady = (b) => Boolean(metaToken && metaAccounts[b]);
  function metaBlockedReason(b) {
    if (!metaToken && !metaAccounts[b]) return 'META_ACCESS_TOKEN is not set, and no ad account is configured for this store';
    if (!metaToken) return 'META_ACCESS_TOKEN is not set';
    if (!metaAccounts[b]) return 'no ad account configured for this store';
    return null;
  }
  const canvaBlockedReason = !canva.configured
    ? 'CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are not set'
    : 'not connected yet. Connect it in Settings';

  const destState = (shot, dest) => (shot.dest || {})[dest] || {};
  const busyDest = (shot, dest) => destState(shot, dest).state === 'sending';
  const doneDest = (shot, dest) => destState(shot, dest).state === 'done';

  return (
    <div className="pane">
      <div className="pane-head">Lifestyle Mockups</div>
      <p className="pane-sub">
        Pick a live product, put it in a scene (Rotate scene writes a fresh one), then attach the result to that product in Shopify, as an extra image or as the main one.
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
          <button
            className="btn btn-ghost" type="button" onClick={rotateScene} disabled={!brand || rotating}
            title={picked ? 'Write a new scene suited to ' + picked.title : 'Write a new scene for this store (pick a product for one suited to it)'}
          >{rotating ? 'Writing...' : '\u21bb Rotate scene'}</button>
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
            <span>Shots</span>
            <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: maxBatch }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
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
        {count > 1 && (variations[brand] || []).length > 0 && (
          <details className="mk-prompt" style={{ marginBottom: 12 }}>
            <summary>How the {count} shots will differ</summary>
            <ol className="mk-varlist">
              {(variations[brand] || []).slice(0, count).map((v, i) => <li key={i}>{v}</li>)}
            </ol>
          </details>
        )}

        <div className="ledger-note">Higher quality takes longer and costs more. There is 300 seconds of headroom, so max is reachable, but you will wait for it.</div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary" onClick={generate} disabled={busy || !picked}>
          {busy ? 'Generating ' + done + ' of ' + count + '...'
            : !picked ? 'Pick a product first'
            : 'Generate ' + count + ' mockup' + (count === 1 ? '' : 's')}
        </button>
        {picked && <div className="ledger-note" style={{ marginTop: 8 }}>Using: {picked.title}</div>}

        {failures.length > 0 && (
          <div className="mk-dests" style={{ marginTop: 10 }}>
            {failures.map((f) => (
              <div className="mk-dest" key={f.index}>
                <span className="mini-dot" style={{ background: 'var(--red)' }} />
                <span>Shot {f.index + 1} failed: {f.error}</span>
              </div>
            ))}
            {!busy && <span className="ledger-note">The rest of the batch is above. Generate again to retry just these.</span>}
          </div>
        )}
      </div>

      {shots.map((shot) => (
        <div className="card" key={shot.key}>
          <div className="card-label">{shot.product.title}</div>
          {shot.variation && <div className="ledger-note" style={{ marginTop: -6 }}>{shot.variation}</div>}
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
              disabled={busyDest(shot, 'shopify') || busyDest(shot, 'main') || doneDest(shot, 'shopify')}
            >
              {busyDest(shot, 'shopify') ? 'Sending...'
                : doneDest(shot, 'shopify') ? 'On the product'
                : 'Add to Shopify'}
            </button>

            <button
              className={'btn btn-ghost' + (doneDest(shot, 'main') ? ' copied' : '')}
              onClick={() => sendMain(shot)}
              disabled={busyDest(shot, 'main') || busyDest(shot, 'shopify') || doneDest(shot, 'main')}
              title="Replaces the product's main image. The old one stays on the product as a secondary image."
            >
              {busyDest(shot, 'main') ? 'Sending...'
                : doneDest(shot, 'main') ? 'Main image'
                : 'Add to Shopify main image'}
            </button>

            <button
              className={'btn btn-ghost' + (doneDest(shot, 'meta') ? ' copied' : '')}
              onClick={() => send(shot, 'meta')}
              disabled={!metaReady(shot.brand) || busyDest(shot, 'meta') || doneDest(shot, 'meta')}
              title={metaReady(shot.brand)
                ? 'Ad account ' + metaAccounts[shot.brand]
                : metaBlockedReason(shot.brand)}
            >
              {busyDest(shot, 'meta') ? 'Sending...'
                : doneDest(shot, 'meta') ? 'In the ad account'
                : 'Send to Meta'}
            </button>

            <button
              className={'btn btn-ghost' + (doneDest(shot, 'canva') ? ' copied' : '')}
              onClick={() => send(shot, 'canva')}
              disabled={!canva.connected || busyDest(shot, 'canva') || doneDest(shot, 'canva')}
              title={canva.connected
                ? 'Uploads to the brand folder in ' + (canva.by || 'the connected') + "'s Canva"
                : 'Canva: ' + canvaBlockedReason}
            >
              {busyDest(shot, 'canva') ? 'Sending...'
                : doneDest(shot, 'canva') ? 'In Canva'
                : 'Send to Canva'}
            </button>

            <button
              className="btn btn-primary"
              onClick={() => sendEverywhere(shot)}
              disabled={busyDest(shot, 'shopify') || busyDest(shot, 'main') || busyDest(shot, 'meta') || busyDest(shot, 'canva')
                || (doneDest(shot, 'shopify')
                  && (!metaReady(shot.brand) || doneDest(shot, 'meta'))
                  && (!canva.connected || doneDest(shot, 'canva')))}
            >Send everywhere</button>
          </div>

          <div className="mk-dests">
            {['shopify', 'main', 'meta', 'canva'].map((dest) => {
              const st = destState(shot, dest);
              if (!st.state || st.state === 'sending') return null;
              const label = { shopify: 'Shopify', main: 'Shopify main image', meta: 'Meta', canva: 'Canva' }[dest];
              return (
                <div className="mk-dest" key={dest}>
                  <span className="mini-dot" style={{
                    background: st.state === 'done' ? 'var(--green)' : 'var(--red)',
                  }} />
                  <span>{label}: {st.state === 'done' ? (st.message || 'sent') : st.message}</span>
                  {st.folderUrl && <a href={st.folderUrl} target="_blank" rel="noreferrer">Open folder</a>}
                </div>
              );
            })}
            {!metaReady(shot.brand) && (
              <div className="mk-dest">
                <span className="mini-dot" style={{ background: 'var(--faint)' }} />
                <span>Meta: {metaBlockedReason(shot.brand)}</span>
              </div>
            )}
            {!canva.connected && (
              <div className="mk-dest">
                <span className="mini-dot" style={{ background: 'var(--faint)' }} />
                <span>Canva: {canvaBlockedReason}</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
