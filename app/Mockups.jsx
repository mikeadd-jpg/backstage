'use client';
// Pick up to ten live products, each gets its own card with a scene Claude writes for it
// the moment it is picked, review or rotate the scenes, then generate every card in one
// go. Each result is reviewed before it goes anywhere. Generated images are held here in
// the browser and nowhere else, so leaving the tab discards anything not attached.
import { useEffect, useMemo, useRef, useState } from 'react';

const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const SIZE_LABELS = { portrait: 'Portrait', square: 'Square', landscape: 'Landscape' };

// Two image calls at a time across the whole run. Five in parallel invites a rate limit
// and buys little over two; one at a time makes ten products a ten minute wait.
const CONCURRENCY = 2;

// Left by the Inspiration tab's "Make one like it": { brand, scene, search, source }.
// Read once on load, then removed, so a refresh does not bring it back.
const SEED_KEY = 'backstage.mockupSeed';
function takeSeed() {
  try {
    const raw = sessionStorage.getItem(SEED_KEY);
    sessionStorage.removeItem(SEED_KEY);
    const s = raw && JSON.parse(raw);
    return s && s.brand && s.scene ? s : null;
  } catch { return null; }
}

export default function Mockups() {
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [scenes, setScenes] = useState({});              // brand -> saved default scene
  const [defaults, setDefaults] = useState({});          // brand -> built-in scene
  const [storeNotes, setStoreNotes] = useState({});      // brand -> standing notes from Settings
  const [metaAccounts, setMetaAccounts] = useState({});   // brand -> ad account id, or null
  const [metaToken, setMetaToken] = useState(true);       // META_ACCESS_TOKEN present at all
  const [canva, setCanva] = useState({ configured: true, connected: false });
  const [sizes, setSizes] = useState(['portrait', 'square', 'landscape']);
  const [ready, setReady] = useState(true);

  const [cache, setCache] = useState({});          // brand -> products
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const [collection, setCollection] = useState('');       // '' = any
  const [tag, setTag] = useState('');                     // '' = any

  const [size, setSize] = useState('portrait');
  const [quality, setQuality] = useState('high');
  const [count, setCount] = useState(1);                  // shots per product
  const [maxBatch, setMaxBatch] = useState(6);
  const [maxProducts, setMaxProducts] = useState(10);
  const [variations, setVariations] = useState({});       // brand -> ordered shot list

  // One job per picked product: its scene, per-product notes and failures. Shots live in
  // their own flat list keyed back to the job, so the send helpers stay simple.
  const [jobs, setJobs] = useState([]);
  const [shots, setShots] = useState([]);                 // newest first, this session only
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One setting for the whole run ("a concert venue"). Every scene written while it is set
  // is a different take on that place. Read through a ref because rotations started by a
  // pick close over an older render.
  const [theme, setTheme] = useState('');
  const themeRef = useRef('');
  useEffect(() => { themeRef.current = theme.trim(); }, [theme]);
  const [rewriting, setRewriting] = useState(false);
  // A scene from the Inspiration tab. While it is set, products picked in its store start
  // with it instead of a freshly written one; Rotate on a card still replaces it there.
  const [seed, setSeed] = useState(null);
  const seedTaken = useRef(undefined); // survives the dev-mode double effect run

  const jobsRef = useRef(jobs);
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);
  const seenRef = useRef({});                             // brand -> scenes already shown
  const shotSeq = useRef(0);

  useEffect(() => {
    fetch('/api/mockups').then((r) => r.json()).then((d) => {
      const bs = d.brands || [];
      setBrands(bs);
      setScenes(d.scenes || {});
      setDefaults(d.defaults || {});
      setStoreNotes(d.notes || {});
      setVariations(d.variations || {});
      if (d.maxBatch) setMaxBatch(d.maxBatch);
      if (d.maxProducts) setMaxProducts(d.maxProducts);
      setMetaAccounts(d.meta || {});
      setMetaToken(d.metaToken !== false);
      if (d.canva) setCanva(d.canva);
      setSizes(d.sizes || sizes);
      setReady(d.ready !== false);
      if (seedTaken.current === undefined) seedTaken.current = takeSeed();
      const s = seedTaken.current;
      if (s && bs.some((b) => b.key === s.brand)) {
        setSeed(s);
        setBrand(s.brand);
        setSearch(s.search || '');
      } else if (bs.length) setBrand(bs[0].key);
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
  // Collection and tag lists come from the products already loaded, so they only ever
  // offer choices that match something in this store.
  const collectionOptions = useMemo(
    () => Array.from(new Set(products.flatMap((p) => p.collections || []))).sort((a, b) => a.localeCompare(b)),
    [products],
  );
  const tagOptions = useMemo(
    () => Array.from(new Set(products.flatMap((p) => p.tags || []))).sort((a, b) => a.localeCompare(b)),
    [products],
  );
  // Search matches the title, any tag or any collection, on top of the two dropdowns.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (collection && !(p.collections || []).includes(collection)) return false;
      if (tag && !(p.tags || []).includes(tag)) return false;
      if (!q) return true;
      return p.title.toLowerCase().includes(q)
        || (p.tags || []).some((t) => t.toLowerCase().includes(q))
        || (p.collections || []).some((c) => c.toLowerCase().includes(q));
    });
  }, [products, search, collection, tag]);

  const brandName = (b) => brands.find((x) => x.key === b)?.name || b;
  const jobKey = (b, p) => b + ':' + p.id;
  const pickedKeys = new Set(jobs.map((j) => j.key));

  function updateJob(key, patch) {
    setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...(typeof patch === 'function' ? patch(j) : patch) } : j)));
  }

  async function post(payload) {
    const res = await fetch('/api/mockups', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, d: await res.json() };
  }

  // Picking a product opens its card and has Claude write a scene for it straight away.
  // Picking it again closes the card (asking first if it holds unsent shots).
  function togglePick(p) {
    setError('');
    const key = jobKey(brand, p);
    if (pickedKeys.has(key)) return removeJob(key);
    if (jobs.length >= maxProducts) return setError('Up to ' + maxProducts + ' products at a time. Remove one to add another.');
    const seeded = seed && seed.brand === brand;
    const job = {
      key, brand, product: p, scene: seeded ? seed.scene : scenes[brand] || defaults[brand] || '',
      notes: '', rotating: false, msg: seeded ? 'Scene from Inspiration.' : '', failures: [],
    };
    setJobs((js) => [...js, job]);
    if (!seeded) rotate(job);
  }

  function removeJob(key) {
    const unsent = shots.filter((s) => s.jobKey === key && !Object.values(s.dest || {}).some((d) => d.state === 'done'));
    if (unsent.length && !window.confirm('This product has ' + unsent.length + ' shot' + (unsent.length === 1 ? '' : 's') + ' not sent anywhere. Remove it and discard them?')) return;
    setJobs((js) => js.filter((j) => j.key !== key));
    setShots((s) => s.filter((sh) => sh.jobKey !== key));
  }

  function clearAll() {
    const unsent = shots.filter((s) => !Object.values(s.dest || {}).some((d) => d.state === 'done'));
    if (unsent.length && !window.confirm(unsent.length + ' shot' + (unsent.length === 1 ? ' has' : 's have') + ' not been sent anywhere. Clear everything anyway?')) return;
    setJobs([]); setShots([]); setError('');
  }

  // Claude writes a new scene for this product. The other cards' scenes and everything
  // already shown for this store this session go along as "already used", so ten picked
  // products get ten different settings rather than ten rewordings of one. Nothing is
  // saved until "Save as default".
  async function rotate(job) {
    updateJob(job.key, { rotating: true, msg: '' });
    const live = jobsRef.current.find((j) => j.key === job.key) || job;
    const others = jobsRef.current
      .filter((j) => j.brand === job.brand && j.key !== job.key)
      .map((j) => j.scene);
    const seen = seenRef.current[job.brand] || [];
    const previous = Array.from(new Set([...others, ...seen].filter(Boolean)));
    try {
      const { ok, d } = await post({
        action: 'suggest-scene', brand: job.brand, product: job.product, current: live.scene, previous,
        theme: themeRef.current,
      });
      if (!ok) return updateJob(job.key, { rotating: false, msg: (d.error || 'Could not write a new scene.') + ' Using the scene shown.' });
      seenRef.current[job.brand] = Array.from(new Set([d.scene, live.scene, ...seen].filter(Boolean))).slice(0, 10);
      updateJob(job.key, { rotating: false, scene: d.scene });
    } catch {
      updateJob(job.key, { rotating: false, msg: 'Could not write a new scene. Using the scene shown.' });
    }
  }

  // Rewrite every card's scene, e.g. after setting a theme. Three at a time rather than
  // all at once, so later cards see the scenes the earlier ones landed on and steer away.
  async function rewriteAll() {
    setError('');
    const list = jobsRef.current.filter((j) => !j.rotating);
    if (!list.length) return;
    setRewriting(true);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, async () => {
      while (next < list.length) await rotate(list[next++]);
    }));
    setRewriting(false);
  }

  async function saveDefault(job) {
    updateJob(job.key, { msg: '' });
    const { ok, d } = await post({ action: 'save-scene', brand: job.brand, scene: job.scene });
    if (!ok) return updateJob(job.key, { msg: d.error || 'Could not save the scene.' });
    setScenes((s) => ({ ...s, [job.brand]: job.scene }));
    updateJob(job.key, { msg: 'Saved as the default for ' + brandName(job.brand) + '.' });
  }

  // One request per image. A run is a client-side queue, not a server-side loop, so a
  // slow or failed shot cannot take the others with it and results appear as they land.
  async function generateOne(job, index) {
    try {
      const { ok, d } = await post({
        action: 'generate', brand: job.brand, imageUrl: job.product.image, scene: job.scene,
        notes: job.notes, size, quality, variationIndex: index,
      });
      if (!ok) return { ok: false, error: d.error || 'Generation failed.' };
      shotSeq.current += 1;
      setShots((s) => [{
        key: job.key + '-' + shotSeq.current, jobKey: job.key, b64: d.b64, prompt: d.prompt || '',
        variation: d.variation || '', product: job.product, brand: job.brand, dest: {},
      }, ...s]);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Request failed.' };
    }
  }

  async function generate(onlyKey) {
    setError('');
    const list = jobsRef.current.filter((j) => !onlyKey || j.key === onlyKey);
    if (!list.length) return setError('Pick a product first.');
    if (list.some((j) => j.rotating)) return setError('Wait for the scenes to finish writing.');
    const empty = list.find((j) => !j.scene.trim());
    if (empty) return setError('Write a scene for ' + empty.product.title + '.');

    // Pinned at the start, so editing a scene or removing a card mid-run is safe.
    const n = Math.max(1, Math.min(count, maxBatch));
    const tasks = list.flatMap((job) => Array.from({ length: n }, (_, index) => ({ job, index })));
    for (const j of list) updateJob(j.key, { failures: [] });
    setBusy(true);
    setProgress({ done: 0, total: tasks.length });

    let next = 0;
    let finished = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const { job, index } = tasks[next++];
        const r = await generateOne(job, index);
        if (!r.ok) updateJob(job.key, (j) => ({ failures: [...j.failures, { index, error: r.error }] }));
        finished++;
        setProgress({ done: finished, total: tasks.length });
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
      const { ok, d } = await post(payload);
      if (!ok) { mark(shot.key, dest, 'failed', d.error || 'Failed.'); return false; }
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

  // Everywhere means the Shopify *main* image, plus Meta and Canva where they are set up.
  async function sendEverywhere(shot) {
    if (!doneDest(shot, 'main')) await sendMain(shot);
    if (metaReady(shot.brand) && !doneDest(shot, 'meta')) await send(shot, 'meta');
    if (canva.connected && !doneDest(shot, 'canva')) await send(shot, 'canva');
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

  const shotsPer = Math.max(1, Math.min(count, maxBatch));
  const totalShots = jobs.length * shotsPer;
  const anyRotating = jobs.some((j) => j.rotating);

  function renderShot(shot) {
    const anyBusy = ['shopify', 'main', 'meta', 'canva'].some((d) => busyDest(shot, d));
    return (
      <div className="mk-shot" key={shot.key}>
        {shot.variation && <div className="ledger-note" style={{ marginBottom: 8 }}>{shot.variation}</div>}
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

        <div className="flag warn" style={{ marginTop: 12 }}>
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
            title="Shopify main image, plus Meta and Canva where they are set up"
            disabled={anyBusy
              || (doneDest(shot, 'main')
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
    );
  }

  return (
    <div className="pane mk-pane">
      <div className="pane-head">Lifestyle Mockups</div>
      <p className="pane-sub">
        Pick up to {maxProducts} live products. Each gets a card with a scene written for it; read them, rotate any you do not like, then generate them all at once.
        Images are held in this tab only: leaving the page throws away anything you have not attached.
      </p>

      {!ready && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span>
          <span>OPENAI_API_KEY is not set, so generation will fail. Add it in Vercel and redeploy.</span>
        </div>
      )}

      <div className="mk-layout">
        <aside className="card mk-picker">
          <div className="field-row">
            <label className="field">
              <span>Store</span>
              <select className="input" value={brand} onChange={(e) => { setBrand(e.target.value); setSearch(''); setCollection(''); setTag(''); }}>
                {brands.length === 0 && <option value="">No stores configured</option>}
                {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Search</span>
              <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="title, tag or collection" />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Collection</span>
              <select className="input" value={collection} onChange={(e) => setCollection(e.target.value)}>
                <option value="">All collections</option>
                {collectionOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Tag</span>
              <select className="input" value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">All tags</option>
                {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
          </div>

          <div className="mk-picker-head">
            <span>Active products</span>
            <span className="acc-count">
              {loadingList ? 'loading...' : filtered.length + ' shown'} · {jobs.length} of {maxProducts} picked
            </span>
          </div>
          <div className="mk-grid">
            {!loadingList && filtered.length === 0 && (
              <div className="ledger-note">No active products with images.</div>
            )}
            {filtered.map((p) => {
              const on = pickedKeys.has(jobKey(brand, p));
              return (
                <button
                  key={p.id}
                  type="button"
                  className={'mk-item' + (on ? ' picked' : '')}
                  onClick={() => togglePick(p)}
                  disabled={!on && jobs.length >= maxProducts}
                  title={p.title}
                >
                  <img className="mk-thumb" src={p.image} alt="" loading="lazy" />
                  <span className="mk-title">{p.title}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="mk-work">
          {seed && (
            <div className="flag ok mk-seed">
              <span className="ico">&#10003;</span>
              <span>
                Inspired by {seed.source}. Products you pick in {brandName(seed.brand)} start with this scene: {seed.scene}{' '}
                <button className="btn btn-ghost" style={{ marginLeft: 6 }} onClick={() => setSeed(null)}>Stop using it</button>
              </span>
            </div>
          )}
          <div className="card">
            <label className="field">
              <span>Theme for every scene (optional)</span>
              <input
                className="input" value={theme} onChange={(e) => setTheme(e.target.value)} maxLength={300}
                placeholder="e.g. a concert venue, an abandoned parking lot"
              />
            </label>
            <div className="reply-actions" style={{ marginTop: -6, marginBottom: 14 }}>
              <button className="btn btn-ghost" type="button" onClick={rewriteAll} disabled={!jobs.length || busy || rewriting || anyRotating}>
                {rewriting ? 'Rewriting...' : '\u21bb Rewrite all scenes'}
              </button>
              <span className="ledger-note">
                {theme.trim()
                  ? 'New picks and every rotate stay in this setting, each a different take on it.'
                  : 'Empty means each scene goes wherever suits its product.'}
              </span>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Shots per product</span>
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
              <details className="mk-prompt" style={{ marginBottom: 12, marginTop: 0 }}>
                <summary>How the {count} shots of each product will differ</summary>
                <ol className="mk-varlist">
                  {(variations[brand] || []).slice(0, count).map((v, i) => <li key={i}>{v}</li>)}
                </ol>
              </details>
            )}
            <div className="ledger-note">Higher quality takes longer and costs more. There is 300 seconds of headroom per image, so max is reachable, but you will wait for it.</div>

            {error && <div className="login-error">{error}</div>}

            <div className="reply-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={() => generate()} disabled={busy || !jobs.length || anyRotating}>
                {busy ? 'Generating ' + progress.done + ' of ' + progress.total + '...'
                  : !jobs.length ? 'Pick products first'
                  : anyRotating ? 'Writing scenes...'
                  : 'Generate all ' + totalShots + ' mockup' + (totalShots === 1 ? '' : 's')}
              </button>
              {jobs.length > 0 && <button className="btn btn-ghost" onClick={clearAll} disabled={busy}>Clear all</button>}
            </div>
          </div>

          {jobs.length === 0 && (
            <div className="ledger-note mk-empty">Picked products appear here as cards, each with a scene written for it.</div>
          )}

          <div className="mk-jobs">
            {jobs.map((job) => {
              const jobShots = shots.filter((s) => s.jobKey === job.key);
              const isDefault = job.scene.trim() === (scenes[job.brand] || defaults[job.brand] || '').trim();
              const standing = storeNotes[job.brand];
              return (
                <div className="card mk-job" key={job.key}>
                  <div className="mk-job-head">
                    <img className="mk-job-thumb" src={job.product.image} alt="" />
                    <div className="mk-job-title">
                      <div className="li-name">{job.product.title}</div>
                      <div className="li-sub">{brandName(job.brand)}</div>
                    </div>
                    <button className="btn btn-ghost" type="button" onClick={() => removeJob(job.key)} disabled={busy} title="Remove this product">&times;</button>
                  </div>

                  <label className="field">
                    <span>Scene</span>
                    <textarea
                      className="textarea" rows={4} value={job.rotating ? '' : job.scene}
                      placeholder={job.rotating ? 'Writing a scene for this product...' : ''}
                      disabled={job.rotating}
                      onChange={(e) => updateJob(job.key, { scene: e.target.value, msg: '' })}
                    />
                  </label>
                  <div className="reply-actions" style={{ marginBottom: 12 }}>
                    <button className="btn btn-ghost" type="button" onClick={() => rotate(job)} disabled={job.rotating || busy}>
                      {job.rotating ? 'Writing...' : '↻ Rotate scene'}
                    </button>
                    <button className="btn btn-ghost" type="button" onClick={() => saveDefault(job)} disabled={job.rotating || !job.scene.trim()}>Save as default</button>
                    <button className="btn btn-ghost" type="button"
                      onClick={() => updateJob(job.key, { scene: scenes[job.brand] || defaults[job.brand] || '', msg: '' })}
                      disabled={job.rotating || isDefault}>Use store default</button>
                    {job.msg && <span className="confidence">{job.msg}</span>}
                  </div>

                  <label className="field">
                    <span>Notes for this product (optional)</span>
                    <input className="input" value={job.notes} onChange={(e) => updateJob(job.key, { notes: e.target.value })} placeholder="e.g. shoot it outdoors, model facing away" />
                  </label>
                  {standing && <div className="ledger-note" style={{ marginTop: -6, marginBottom: 12 }}>Store notes (from Settings): {standing}</div>}

                  <button className="btn btn-ghost" type="button" onClick={() => generate(job.key)} disabled={busy || job.rotating}>
                    Generate just this one ({shotsPer})
                  </button>

                  {job.failures.length > 0 && (
                    <div className="mk-dests" style={{ marginTop: 10 }}>
                      {job.failures.map((f) => (
                        <div className="mk-dest" key={f.index}>
                          <span className="mini-dot" style={{ background: 'var(--red)' }} />
                          <span>Shot {f.index + 1} failed: {f.error}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {jobShots.map(renderShot)}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
