'use client';
// Carousel ads from the images already in a brand's Meta ad account. Approving a mockup
// means sending it to Meta from the Mockups tab, so the library is the list of keepers:
// pick 2 to 10, order them, check each card's headline and link, build. The result is a
// creative (an unpublished post) in the ad account, which can then go into an existing
// ad set as a PAUSED ad. Switching it on stays in Ads Manager, on purpose: nothing here
// runs or spends.
//
// Video mode does the same for a reel made in Canva: pick the design, Backstage exports it
// as MP4 and has Meta fetch it into the ad account, then builds a video creative from it.
// Each stage is its own request, polled from here, so no request waits on a long export.
import { useEffect, useMemo, useRef, useState } from 'react';

const CTA_LABELS = {
  SHOP_NOW: 'Shop now', ORDER_NOW: 'Order now', BUY_NOW: 'Buy now', LEARN_MORE: 'Learn more', SEE_MORE: 'See more',
};

export default function Ads() {
  const [config, setConfig] = useState(null);
  const [brand, setBrand] = useState('');
  const [libs, setLibs] = useState({});                  // brand -> { images, products, shopUrl }
  const [loading, setLoading] = useState(false);
  const [onlyMockups, setOnlyMockups] = useState(true);
  const [search, setSearch] = useState('');

  const [cards, setCards] = useState([]);                 // in carousel order
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [textNotes, setTextNotes] = useState('');         // this ad only
  const [storeNotes, setStoreNotes] = useState({});       // brand -> standing copy notes
  const [storeNotesMsg, setStoreNotesMsg] = useState('');
  const [writing, setWriting] = useState(false);
  const [textHistory, setTextHistory] = useState([]);     // earlier drafts, newest first
  const [cta, setCta] = useState('SHOP_NOW');
  const [reorder, setReorder] = useState(false);
  const [endCard, setEndCard] = useState(false);
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState({});               // brand -> creatives
  const [error, setError] = useState('');

  // Putting a built carousel into an ad set, always as a paused ad.
  const [attach, setAttach] = useState(null);             // { id, name } of the creative
  const [adsets, setAdsets] = useState({});               // brand -> ad sets
  const [adsetsLoading, setAdsetsLoading] = useState(false);
  const [adsetId, setAdsetId] = useState('');
  const [adName, setAdName] = useState('');
  const [adding, setAdding] = useState(false);
  const [adResult, setAdResult] = useState(null);
  const [adError, setAdError] = useState('');
  const [adsetFilter, setAdsetFilter] = useState('active'); // 'active' | 'recent' | 'all'

  const [mode, setMode] = useState('carousel');           // 'carousel' | 'video'
  // Video from Canva.
  const [designs, setDesigns] = useState(null);           // null = not loaded yet
  const [designsCont, setDesignsCont] = useState(null);
  const [designsLoading, setDesignsLoading] = useState(false);
  const [designQuery, setDesignQuery] = useState('');
  const [design, setDesign] = useState(null);
  const [vStage, setVStage] = useState('idle');           // idle|exporting|uploading|processing|ready|failed
  const [vMsg, setVMsg] = useState('');
  const [exportUrl, setExportUrl] = useState('');
  const [videoId, setVideoId] = useState('');
  const [vHeadline, setVHeadline] = useState('');
  const [vLink, setVLink] = useState('');
  const [vHandle, setVHandle] = useState('');
  const [access, setAccess] = useState(null);            // { brand, data } from Check Meta access
  const [checking, setChecking] = useState(false);
  const run = useRef(0);                                  // bumps to abandon a stale send

  // Landing page: a Shopify collection of the ad's products, one per mode.
  const [lp, setLp] = useState({});                       // mode -> created collection
  const [lpTitle, setLpTitle] = useState({});             // mode -> title being typed
  const [lpBusy, setLpBusy] = useState(false);
  const [lpError, setLpError] = useState('');
  const [vPicked, setVPicked] = useState([]);             // product handles in the reel, in order
  const [lpSearch, setLpSearch] = useState('');
  const [collections, setCollections] = useState({});     // brand -> [{ id, title }]
  const [alsoLike, setAlsoLike] = useState({});           // mode -> collection id

  useEffect(() => {
    fetch('/api/ads').then((r) => r.json()).then((d) => {
      if (d.error) return setError(d.error);
      setConfig(d);
      setStoreNotes(Object.fromEntries((d.brands || []).map((b) => [b.key, b.textNotes || ''])));
      if (d.brands && d.brands.length) setBrand(d.brands[0].key);
    }).catch(() => setError('Could not load the ad accounts.'));
  }, []);

  async function post(payload) {
    const res = await fetch('/api/ads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, d: await res.json() };
  }

  async function loadRecent(b) {
    const { ok, d } = await post({ action: 'recent', brand: b }).catch(() => ({ ok: false, d: {} }));
    if (ok) setRecent((r) => ({ ...r, [b]: d.creatives || [] }));
  }

  useEffect(() => {
    if (!brand || !config || !config.tokenSet) return;
    loadRecent(brand);
    if (libs[brand]) return;
    setLoading(true); setError('');
    post({ action: 'library', brand })
      .then(({ ok, d }) => {
        if (!ok) setError(d.error || 'Could not load the image library.');
        else setLibs((l) => ({ ...l, [brand]: d }));
      })
      .catch(() => setError('Could not load the image library.'))
      .finally(() => setLoading(false));
  }, [brand, config]);

  const lib = libs[brand] || { images: [], products: [], shopUrl: '' };
  const brandInfo = (config && config.brands.find((b) => b.key === brand)) || null;
  const maxCards = (config && config.maxCards) || 10;
  const minCards = (config && config.minCards) || 2;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return lib.images.filter((img) => {
      if (onlyMockups && !img.mockup) return false;
      if (!q) return true;
      return (img.title || '').toLowerCase().includes(q) || img.name.toLowerCase().includes(q);
    });
  }, [lib, onlyMockups, search]);

  const productLink = (handle) => (lib.shopUrl ? lib.shopUrl + '/products/' + handle : '');

  function switchBrand(b) {
    if (cards.length && !window.confirm('Switching store clears the ' + cards.length + ' card' + (cards.length === 1 ? '' : 's') + ' you have picked. Carry on?')) return;
    setCards([]); setResult(null); setError(''); setSearch(''); setTextHistory([]); setStoreNotesMsg(''); setAttach(null); setAdsetId('');
    resetVideo();   // a sent video belongs to the old store's ad account
    setLp({}); setLpTitle({}); setVPicked([]); setLpError(''); setAlsoLike({});
    setBrand(b);
  }

  async function checkAccess() {
    setChecking(true); setAccess(null);
    const b = brand;
    const { ok, d } = await post({ action: 'check-access', brand: b }).catch(() => ({ ok: false, d: {} }));
    setAccess({ brand: b, data: ok ? d : null, error: ok ? '' : (d.error || 'Could not check.') });
    setChecking(false);
  }

  // ---- video from Canva ----

  const canva = (config && config.canva) || { configured: false, connected: false, designs: false };

  async function loadDesigns({ more = false } = {}) {
    setDesignsLoading(true); setError('');
    try {
      const { ok, d } = await post({ action: 'canva-designs', query: designQuery, continuation: more ? designsCont : '' });
      if (!ok) return setError(d.error || 'Could not load your Canva designs.');
      setDesigns((prev) => (more && prev ? [...prev, ...(d.designs || [])] : d.designs || []));
      setDesignsCont(d.continuation || null);
    } catch {
      setError('Could not load your Canva designs.');
    } finally {
      setDesignsLoading(false);
    }
  }

  useEffect(() => {
    if (mode === 'video' && canva.designs && designs === null && !designsLoading) loadDesigns();
  }, [mode, config]);

  function resetVideo() {
    run.current += 1;
    setVStage('idle'); setVMsg(''); setExportUrl(''); setVideoId('');
  }

  function pickDesign(d) {
    if (vStage === 'exporting' || vStage === 'uploading' || vStage === 'processing') {
      if (!window.confirm('A video is still being sent. Switch to this design and abandon it?')) return;
    }
    resetVideo(); setResult(null); setError('');
    setDesign(d);
    if (!vHeadline) setVHeadline(d.title);
    if (!vLink) setVLink(lib.shopUrl || '');
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Export from Canva, hand the file to Meta, wait for Meta to process it. Each stage is
  // polled with its own requests; a newer send or a store switch abandons this one.
  async function sendVideo() {
    if (!design) return;
    const mine = ++run.current;
    const live = () => run.current === mine;
    setError(''); setResult(null); setVMsg(''); setExportUrl(''); setVideoId('');
    const fail = (msg) => { if (live()) { setVStage('failed'); setVMsg(msg); } };
    try {
      setVStage('exporting');
      const vertical = !(design.width && design.height) || design.height >= design.width;
      let r = await post({ action: 'video-export', designId: design.id, vertical });
      if (!r.ok) return fail(r.d.error || 'Canva would not export the design.');
      const exportId = r.d.exportId;
      let url = '';
      for (let i = 0; i < 100 && live(); i++) {           // about five minutes
        await wait(3000);
        r = await post({ action: 'video-export-status', exportId });
        if (!r.ok) return fail(r.d.error || 'Could not check the Canva export.');
        if (r.d.status === 'failed') return fail(r.d.error || 'Canva could not export the design.');
        if (r.d.status === 'success' && r.d.url) { url = r.d.url; break; }
      }
      if (!live()) return;
      if (!url) return fail('Canva is taking unusually long to export. Try again in a few minutes.');
      setExportUrl(url);

      setVStage('uploading');
      r = await post({ action: 'video-to-meta', brand, url, title: design.title });
      if (!r.ok) return fail(r.d.error || 'Meta would not take the video.');
      const id = r.d.videoId;
      if (!live()) return;
      setVideoId(id);

      setVStage('processing');
      for (let i = 0; i < 120 && live(); i++) {           // about ten minutes
        await wait(5000);
        r = await post({ action: 'video-status', brand, videoId: id });
        if (!r.ok) return fail(r.d.error || 'Could not check the video in Meta.');
        if (r.d.status === 'error') return fail(r.d.error);
        if (r.d.status === 'ready') { if (live()) setVStage('ready'); return; }
        if (live() && r.d.progress != null) setVMsg(r.d.progress + '%');
      }
      fail('Meta is still processing the video. Send it again in a few minutes.');
    } catch {
      fail('Request failed.');
    }
  }

  function pickVideoProduct(handle) {
    setVHandle(handle);
    const p = lib.products.find((x) => x.handle === handle);
    if (p) { setVHeadline(p.title); setVLink(productLink(handle)); }
    setResult(null);
  }

  const vProblems = [];
  if (!design) vProblems.push('Pick a Canva design.');
  else if (vStage !== 'ready') vProblems.push('Send the video to Meta and wait for it to be ready.');
  if (!/^https?:\/\/\S+$/i.test(vLink.trim())) vProblems.push('The ad needs a link starting with https://.');
  if (brandInfo && !brandInfo.page) vProblems.push('No Facebook Page found for ' + brandInfo.name + '. Set ' + brand.toUpperCase() + '_META_PAGE_ID in Vercel.');

  // ---- landing page ----

  // The products the page will hold, in ad order: the cards' products for a carousel
  // (cards with no product are left out), the picked list for a video.
  const lpHandles = mode === 'video'
    ? vPicked
    : [...new Set(cards.map((c) => c.handle).filter(Boolean))];
  const titleOf = (h) => (lib.products.find((p) => p.handle === h) || {}).title || h;
  const lpFound = lp[mode] || null;

  // Collections for "you might also like", fetched the first time a landing section shows.
  const showLanding = mode === 'video' ? Boolean(design) : cards.length > 0;
  useEffect(() => {
    if (!showLanding || !brand || collections[brand]) return;
    setCollections((c) => ({ ...c, [brand]: [] }));     // claim it so it loads once
    post({ action: 'collections', brand })
      .then(({ ok, d }) => { if (ok) setCollections((c) => ({ ...c, [brand]: d.collections || [] })); })
      .catch(() => {});
  }, [showLanding, brand]);

  function toggleVPicked(handle) {
    setVPicked((list) => (list.includes(handle) ? list.filter((h) => h !== handle) : [...list, handle]));
  }

  async function createLanding() {
    setLpError(''); setLpBusy(true);
    const m = mode;
    const title = (lpTitle[m] || '').trim() || (m === 'video' && design ? design.title : name.trim());
    try {
      const { ok, d } = await post({ action: 'landing-page', brand, title, handles: lpHandles, alsoLike: alsoLike[m] || '' });
      if (!ok) return setLpError(d.error || 'Shopify would not create the landing page.');
      setLp((x) => ({ ...x, [m]: d }));
      setResult(null);
      // A video ad has one link, so it goes straight there. A carousel keeps its card
      // links and uses the page as its main link at build time.
      if (m === 'video' && d.published && d.url) { setVLink(d.url); setVHandle(''); }
    } catch {
      setLpError('Request failed.');
    } finally {
      setLpBusy(false);
    }
  }

  async function buildVideo() {
    setError(''); setResult(null); setBuilding(true);
    try {
      const { ok, d } = await post({
        action: 'build-video', brand, videoId, name, message, cta,
        headline: vHeadline, link: vLink,
      });
      if (!ok) setError(d.error || 'Meta would not create the video ad.');
      else { setResult(d); loadRecent(brand); startAttach({ id: d.id, name: d.name }); }
    } catch {
      setError('Request failed.');
    } finally {
      setBuilding(false);
    }
  }

  const ratio = design && design.width && design.height ? design.height / design.width : null;
  const lpFilteredProducts = useMemo(() => {
    const q = lpSearch.trim().toLowerCase();
    return (lib.products || []).filter((p) => !q || p.title.toLowerCase().includes(q)).slice(0, 200);
  }, [lib, lpSearch]);

  const landingSection = (
    <div className="ad-landing">
      <div className="li-name">Landing page{mode === 'carousel' ? ' (optional)' : ''}</div>
      <div className="ledger-note" style={{ marginBottom: 10 }}>
        {mode === 'carousel'
          ? 'A Shopify collection of the carousel\'s products, in card order. Taps on the text, end card and "See more" go there instead of the homepage; each card still links to its own product.'
          : 'A Shopify collection of the products in this reel, in the order you tick them. The ad links to it, so every product in the reel is one tap away.'}
      </div>

      {mode === 'video' && (
        <>
          <input className="input" value={lpSearch} onChange={(e) => setLpSearch(e.target.value)} placeholder="Find products in the reel" style={{ marginBottom: 6 }} />
          <div className="ad-lp-list">
            {lpFilteredProducts.map((p) => {
              const at = vPicked.indexOf(p.handle);
              return (
                <label key={p.handle} className={'ad-lp-row' + (at >= 0 ? ' on' : '')}>
                  <input type="checkbox" checked={at >= 0} onChange={() => { toggleVPicked(p.handle); setLp((x) => ({ ...x, video: null })); }} />
                  {p.image && <img src={p.image} alt="" />}
                  <span>{p.title}</span>
                  {at >= 0 && <span className="ad-pos static ad-lp-pos">{at + 1}</span>}
                </label>
              );
            })}
          </div>
        </>
      )}

      {lpHandles.length > 0 ? (
        <div className="ledger-note" style={{ margin: '8px 0' }}>
          {lpHandles.length} product{lpHandles.length === 1 ? '' : 's'}: {lpHandles.map(titleOf).join(', ')}
          {mode === 'carousel' && cards.some((c) => !c.handle) && '. Cards without a product are left out.'}
        </div>
      ) : (
        <div className="ledger-note" style={{ margin: '8px 0' }}>
          {mode === 'carousel' ? 'Pick cards that are linked to products first.' : 'Tick the products that appear in the reel.'}
        </div>
      )}

      <label className="field" style={{ marginBottom: 8 }}>
        <span>"You might also like" below the products (optional)</span>
        <select className="input" value={alsoLike[mode] || ''} onChange={(e) => setAlsoLike((a) => ({ ...a, [mode]: e.target.value }))}>
          <option value="">None</option>
          {(collections[brand] || []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        </select>
      </label>
      {alsoLike[mode] && (
        <details className="mk-prompt" style={{ marginTop: -2, marginBottom: 10 }}>
          <summary>One-time theme setup per store, or the row will not show</summary>
          {brand === 'wallspoke' ? (
            <ol className="mk-varlist">
              <li>Shopify admin: Online Store, Themes, then the three dots on the live theme, Edit code.</li>
              <li>Sections, Add a new section named <b>also-like</b>; paste themes/wallspoke/sections/also-like.liquid from the repo. Save.</li>
              <li>Templates, Add a new template: collection, JSON, named <b>landing</b>; paste themes/wallspoke/templates/collection.landing.json. Save.</li>
            </ol>
          ) : (
          <ol className="mk-varlist">
            <li>Shopify admin: Online Store, Themes, Customize.</li>
            <li>In the page picker at the top choose Collections, then Create template. Name it <b>landing</b>, based on the default collection template.</li>
            <li>Add section: Featured collection. Set its heading to "You might also like".</li>
            <li>On its Collection setting, click the dynamic source (database) icon and choose <b>You might also like</b>. Save.</li>
          </ol>
          )}
          <div className="ledger-note">Backstage creates the "You might also like" field the first time you use it, so it appears in step 4 after one landing page has been made with it.</div>
        </details>
      )}

      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <label className="field">
          <span>Page title (the heading shoppers see)</span>
          <input className="input" value={lpTitle[mode] || ''} onChange={(e) => setLpTitle((t) => ({ ...t, [mode]: e.target.value }))}
            placeholder={(mode === 'video' && design ? design.title : name) || 'e.g. The Fall Lifestyle Drop'} />
        </label>
        <div className="field" style={{ flex: '0 0 auto', minWidth: 0 }}>
          <button className="btn btn-ghost" type="button" onClick={createLanding}
            disabled={lpBusy || !lpHandles.length || !((lpTitle[mode] || '').trim() || (mode === 'video' && design ? design.title : name.trim()))}>
            {lpBusy ? 'Creating...' : lpFound ? 'Create another' : 'Create landing page'}
          </button>
        </div>
      </div>
      {lpError && <div className="login-error">{lpError}</div>}
      {lpFound && (
        <div className={'flag ' + (lpFound.published ? 'ok' : 'warn')} style={{ marginTop: 4 }}>
          <span className="ico">{lpFound.published ? '\u2713' : '\u2691'}</span>
          <span>
            {lpFound.published
              ? <>Landing page live: <a href={lpFound.url} target="_blank" rel="noreferrer">{lpFound.url}</a>. {mode === 'video' ? 'Set as the ad\'s link.' : 'Used as the carousel\'s main link when you build.'}</>
              : lpFound.publishError}
            {lpFound.alsoLike && ' "You might also like" is set; it shows once the store\'s theme has the landing template.'}
            {' '}<a href={lpFound.adminUrl} target="_blank" rel="noreferrer">Open in Shopify</a>
          </span>
        </div>
      )}
    </div>
  );

  const STAGES = [['exporting', 'Exporting from Canva'], ['uploading', 'Sending to Meta'], ['processing', 'Meta is processing'], ['ready', 'Ready']];

  function toggle(img) {
    setResult(null); setError('');
    if (cards.some((c) => c.hash === img.hash)) return setCards((cs) => cs.filter((c) => c.hash !== img.hash));
    if (cards.length >= maxCards) return setError('A carousel holds at most ' + maxCards + ' cards.');
    setCards((cs) => [...cs, {
      hash: img.hash, url: img.url, width: img.width, height: img.height,
      handle: img.handle || '',
      headline: img.title || '',
      link: img.handle ? productLink(img.handle) : lib.shopUrl,
    }]);
  }

  function updateCard(hash, patch) {
    setResult(null);
    setCards((cs) => cs.map((c) => (c.hash === hash ? { ...c, ...patch } : c)));
  }

  function move(i, dir) {
    setResult(null);
    setCards((cs) => {
      const j = i + dir;
      if (j < 0 || j >= cs.length) return cs;
      const next = cs.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function pickProduct(hash, handle) {
    const p = lib.products.find((x) => x.handle === handle);
    if (p) updateCard(hash, { handle, headline: p.title, link: productLink(handle) });
  }

  const problems = [];
  if (cards.length < minCards) problems.push('Pick at least ' + minCards + ' images.');
  cards.forEach((c, i) => {
    if (!c.headline.trim()) problems.push('Card ' + (i + 1) + ' needs a headline.');
    if (!/^https?:\/\/\S+$/i.test(c.link.trim())) problems.push('Card ' + (i + 1) + ' needs a link starting with https://.');
  });
  if (brandInfo && !brandInfo.page) problems.push('No Facebook Page found for ' + brandInfo.name + '. Set ' + brand.toUpperCase() + '_META_PAGE_ID in Vercel.');

  // Claude drafts the primary text from the cards' products. Every earlier draft goes
  // along as "already written", so Rewrite moves to a new angle. Undo steps back.
  async function writeText() {
    setError(''); setWriting(true);
    const previous = [message, ...textHistory].map((t) => t.trim()).filter(Boolean);
    try {
      const { ok, d } = await post({
        action: 'write-text', brand, notes: textNotes, previous,
        titles: mode === 'video'
          ? [vHeadline, ...vPicked.map((h) => (lib.products.find((p) => p.handle === h) || {}).title), design && design.title].filter(Boolean)
          : cards.map((c) => c.headline).filter(Boolean),
      });
      if (!ok) return setError(d.error || 'Could not write the text.');
      if (message.trim()) setTextHistory((h) => [message, ...h].slice(0, 10));
      setMessage(d.text);
      setResult(null);
    } catch {
      setError('Could not write the text.');
    } finally {
      setWriting(false);
    }
  }

  function undoText() {
    const [last, ...rest] = textHistory;
    if (last === undefined) return;
    setMessage(last); setTextHistory(rest);
  }

  async function saveStoreNotes() {
    setStoreNotesMsg('');
    const { ok, d } = await post({ action: 'save-text-notes', brand, notes: storeNotes[brand] || '' })
      .catch(() => ({ ok: false, d: {} }));
    setStoreNotesMsg(ok ? 'Saved for every ' + (brandInfo ? brandInfo.name : brand) + ' ad.' : (d.error || 'Could not save.'));
  }

  function startAttach(creative) {
    setAttach(creative); setAdName(creative.name || ''); setAdResult(null); setAdError('');
    if (!adsets[brand]) loadAdsets();
  }

  // Also behind the Refresh button, for a campaign or ad set made in Ads Manager after the
  // list was loaded. The chosen ad set is kept if it is still there.
  function loadAdsets() {
    const b = brand;
    setAdsetsLoading(true); setAdError('');
    post({ action: 'adsets', brand: b })
      .then(({ ok, d }) => {
        if (!ok) return setAdError(d.error || 'Could not load the ad sets.');
        const list = d.adsets || [];
        setAdsets((a) => ({ ...a, [b]: list }));
        setAdsetId((id) => (list.some((x) => x.id === id) ? id : ''));
      })
      .catch(() => setAdError('Could not load the ad sets.'))
      .finally(() => setAdsetsLoading(false));
  }

  async function addToAdSet() {
    setAdError(''); setAdResult(null); setAdding(true);
    try {
      const { ok, d } = await post({ action: 'create-ad', brand, creativeId: attach.id, adsetId, name: adName });
      if (!ok) setAdError(d.error || 'Meta would not create the ad.');
      else setAdResult(d);
    } catch {
      setAdError('Request failed.');
    } finally {
      setAdding(false);
    }
  }

  // Ad sets grouped under their campaign, most recently edited campaign first. A campaign
  // counts as edited when it or any of its ad sets was, since editing an ad set does not
  // move the campaign's own timestamp.
  const RECENT_DAYS = 30;
  const allCampaigns = useMemo(() => {
    const groups = new Map();
    for (const a of adsets[brand] || []) {
      const k = a.campaignId || 'none';
      if (!groups.has(k)) groups.set(k, { key: k, name: a.campaignName, status: a.campaignStatus, edited: a.campaignUpdated || '', sets: [] });
      const g = groups.get(k);
      g.sets.push(a);
      if (a.updated && a.updated > g.edited) g.edited = a.updated;
    }
    return [...groups.values()].sort((x, y) => y.edited.localeCompare(x.edited) || x.name.localeCompare(y.name));
  }, [adsets, brand]);
  const campaigns = useMemo(() => {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    return allCampaigns.filter((c) => (adsetFilter === 'active' ? c.status === 'ACTIVE'
      : adsetFilter === 'recent' ? Date.parse(c.edited) >= Date.parse(cutoff)
      : true));
  }, [allCampaigns, adsetFilter]);
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

  async function build() {
    setError(''); setResult(null); setBuilding(true);
    try {
      const { ok, d } = await post({
        action: 'build', brand, name, message, cta, reorder, endCard,
        mainLink: lp.carousel && lp.carousel.published ? lp.carousel.url : '',
        cards: cards.map((c) => ({ hash: c.hash, headline: c.headline, link: c.link })),
      });
      if (!ok) setError(d.error || 'Meta would not create the carousel.');
      else { setResult(d); loadRecent(brand); startAttach({ id: d.id, name: d.name }); }
    } catch {
      setError('Request failed.');
    } finally {
      setBuilding(false);
    }
  }

  // Primary text, notes and the Claude buttons: the same for a carousel and a video.
  const textBlock = (
    <>
            <label className="field">
              <span>Primary text (above the {mode === 'video' ? 'video' : 'carousel'})</span>
              <textarea className="textarea" rows={3} value={message} onChange={(e) => { setMessage(e.target.value); setResult(null); }}
                placeholder={'Write it yourself, or have Claude draft it from the ' + (mode === 'video' ? 'headline' : 'cards')} />
            </label>
            {message.length > 125 && (
              <div className="ledger-note" style={{ marginTop: -8, marginBottom: 10 }}>
                Meta shows about the first 125 characters before "See more": {message.slice(0, 125)}...
              </div>
            )}
            <label className="field">
              <span>Notes for this ad's text (optional)</span>
              <input className="input" value={textNotes} onChange={(e) => setTextNotes(e.target.value)}
                placeholder="e.g. lead with Halloween, mention the new hoodies" />
            </label>
            <div className="reply-actions" style={{ marginTop: -4, marginBottom: 12 }}>
              <button className="btn btn-ghost" type="button" onClick={writeText} disabled={writing || !brand}>
                {writing ? 'Writing...' : message.trim() ? '\u21bb Rewrite with Claude' : 'Write with Claude'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={undoText} disabled={writing || !textHistory.length}>Undo</button>
              {mode === 'carousel' && !cards.length && <span className="ledger-note">Pick the cards first and the text is written for those products.</span>}
            </div>
            <details className="mk-prompt" style={{ marginTop: 0, marginBottom: 12 }}>
              <summary>Store notes for every {brandInfo ? brandInfo.name : ''} ad{(storeNotes[brand] || '').trim() ? ' (set)' : ''}</summary>
              <textarea className="textarea" rows={3} style={{ marginTop: 8 }} value={storeNotes[brand] || ''}
                onChange={(e) => { setStoreNotes((n) => ({ ...n, [brand]: e.target.value })); setStoreNotesMsg(''); }}
                placeholder="Rules for every ad's text, e.g. never mention discounts; we ship worldwide" />
              <div className="reply-actions" style={{ marginTop: 6 }}>
                <button className="btn btn-ghost" type="button" onClick={saveStoreNotes}>Save store notes</button>
                {storeNotesMsg && <span className="confidence">{storeNotesMsg}</span>}
              </div>
            </details>
    </>
  );

  const adsManager = brandInfo ? 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=' + brandInfo.account : '';

  if (!config) {
    return (
      <div className="pane"><div className="pane-head">Ads</div>
        <p className="pane-sub">{error || 'Loading...'}</p></div>
    );
  }

  return (
    <div className="pane mk-pane">
      <div className="pane-head">Ads</div>
      <p className="pane-sub">
        Build a carousel from images already in the store's Meta ad account, or a video ad from a reel you made in Canva.
        Nothing here runs or spends: ads are only ever added to an ad set paused, and you switch them on in Ads Manager.
      </p>
      <div className="pf-chips" role="tablist" aria-label="Kind of ad">
        {[['carousel', 'Carousel'], ['video', 'Video from Canva']].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} className={'chip' + (mode === k ? ' active' : '')}
            onClick={() => { setMode(k); setResult(null); setError(''); setAttach(null); setTextHistory([]); }}>{label}</button>
        ))}
      </div>

      {!config.tokenSet && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span>
          <span>META_ACCESS_TOKEN is not set, so the ad accounts cannot be read.</span>
        </div>
      )}
      {config.brands.length === 0 && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span>
          <span>No store has a Meta ad account. Set &lt;BRAND&gt;_META_AD_ACCOUNT_ID in Vercel.</span>
        </div>
      )}

      <div className="mk-layout">
        <aside className="card mk-picker">
          <div className="field-row">
            <label className="field">
              <span>Store</span>
              <select className="input" value={brand} onChange={(e) => switchBrand(e.target.value)}>
                {config.brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select>
            </label>
            {mode === 'carousel' ? (
              <label className="field">
                <span>Search</span>
                <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="product or file name" />
              </label>
            ) : (
              <form className="field" onSubmit={(e) => { e.preventDefault(); loadDesigns(); }}>
                <span>Search Canva</span>
                <input className="input" value={designQuery} onChange={(e) => setDesignQuery(e.target.value)} placeholder="design title, then Enter" disabled={!canva.designs} />
              </form>
            )}
          </div>
          {mode === 'carousel' && (
            <label className="check" style={{ marginTop: -4 }}>
              <input type="checkbox" checked={onlyMockups} onChange={(e) => setOnlyMockups(e.target.checked)} />
              Backstage mockups only
            </label>
          )}
          {brandInfo && (
            <div className="ledger-note" style={{ marginBottom: 8 }}>
              Ad account {brandInfo.account} · {brandInfo.page
                ? 'posts as ' + (brandInfo.page.name || 'Page') + ' (' + brandInfo.page.id + ')' +
                  (brandInfo.page.source === 'env' ? ', set in Vercel' : ', found automatically')
                : brandInfo.pageError ? 'Page lookup failed: ' + brandInfo.pageError
                : 'no Page found' + (brandInfo.pageCandidates.length
                  ? '. Meta lists ' + brandInfo.pageCandidates.map((p) => p.name + ' (' + p.id + ')').join(', ')
                  : '')}
              {brandInfo.page && (' · Instagram: ' + (brandInfo.instagram
                ? (brandInfo.instagram.username ? '@' + brandInfo.instagram.username : brandInfo.instagram.id) +
                  (brandInfo.instagram.source === 'env' ? ', set in Vercel' : ', linked to the Page')
                : 'none linked, ads show the Page there'))}
              {' · '}<button type="button" className="link-inline" onClick={checkAccess} disabled={checking}>
                {checking ? 'Checking...' : 'Check Meta access'}
              </button>
            </div>
          )}
          {access && access.brand === brand && (
            <div className="mk-dests" style={{ marginTop: 0, marginBottom: 10 }}>
              {access.error && <div className="mk-dest"><span className="mini-dot" style={{ background: 'var(--red)' }} /><span>{access.error}</span></div>}
              {access.data && (() => {
                const a = access.data;
                const rows = [
                  [a.token.ok, a.token.ok ? 'Token works, acting as ' + a.token.name : 'Token rejected: ' + a.token.error],
                  [a.permissions.missing.length === 0,
                    a.permissions.missing.length === 0 ? 'Token has every permission needed'
                      : 'Token is missing: ' + a.permissions.missing.join(', ') + '. Generate a new system user token with these ticked.'],
                  [a.adAccount.ok, a.adAccount.ok ? 'Ad account ' + a.adAccount.id + ' (' + a.adAccount.name + ') answers'
                    : 'Ad account ' + a.adAccount.id + ' refused: ' + a.adAccount.error + '. Assign it to the system user with Manage campaigns.'],
                  a.page && [a.page.assigned && a.page.canAdvertise,
                    !a.page.assigned ? 'Page ' + a.page.id + ' is not assigned to the token. Business Settings, System users, Assign assets, the Page, with Create ads.'
                      : a.page.canAdvertise ? 'Page ' + a.page.name + ' can be advertised as'
                      : 'Page ' + a.page.name + ' is assigned without the ad task (' + (a.page.tasks.join(', ') || 'none') + '). Give the system user Create ads on it.'],
                  a.instagram && [a.instagram.ok, a.instagram.ok ? 'Instagram @' + a.instagram.username + ' readable'
                    : 'Instagram account not usable: ' + a.instagram.error],
                ].filter(Boolean);
                return rows.map(([good, text], i) => (
                  <div className="mk-dest" key={i}>
                    <span className="mini-dot" style={{ background: good ? 'var(--green)' : 'var(--red)' }} />
                    <span>{text}</span>
                  </div>
                ));
              })()}
            </div>
          )}

          {mode === 'video' && (
            <>
              <div className="mk-picker-head">
                <span>Canva designs{canva.by ? ' in ' + canva.by + "'s account" : ''}</span>
                <span className="acc-count">{designsLoading ? 'loading...' : designs ? designs.length + ' shown' : ''}</span>
              </div>
              {!canva.configured ? (
                <div className="ledger-note">Canva is not set up: CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are missing.</div>
              ) : !canva.connected ? (
                <div className="ledger-note">Canva is not connected. Connect it in Settings.</div>
              ) : !canva.designs ? (
                <div className="flag warn" style={{ marginTop: 0 }}>
                  <span className="ico">&#9873;</span>
                  <span>
                    The Canva connection predates reading designs. In Canva's Developer Portal, tick <b>design:meta:read</b> and
                    {' '}<b>design:content:read</b> on the integration, then press Reconnect under Canva in Settings.
                  </span>
                </div>
              ) : (
                <div className="mk-grid">
                  {designs && designs.length === 0 && <div className="ledger-note">No designs found.</div>}
                  {(designs || []).map((d) => (
                    <button key={d.id} type="button" className={'mk-item' + (design && design.id === d.id ? ' picked' : '')}
                      onClick={() => pickDesign(d)} title={d.title}>
                      {d.thumb ? <img className="mk-thumb" src={d.thumb} alt="" loading="lazy" /> : <span className="mk-thumb" />}
                      <span className="mk-title">{d.title}</span>
                    </button>
                  ))}
                  {designsCont && (
                    <button type="button" className="btn btn-ghost" onClick={() => loadDesigns({ more: true })} disabled={designsLoading}>
                      {designsLoading ? 'Loading...' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {mode === 'carousel' && (<>
          <div className="mk-picker-head">
            <span>Image library</span>
            <span className="acc-count">
              {loading ? 'loading...' : shown.length + ' shown'} · {cards.length} of {maxCards} picked
            </span>
          </div>
          <div className="mk-grid">
            {!loading && shown.length === 0 && (
              <div className="ledger-note">
                {onlyMockups ? 'No Backstage mockups in this ad account yet. Send some from the Mockups tab, or untick the box.' : 'No images in this ad account.'}
              </div>
            )}
            {shown.map((img) => {
              const pos = cards.findIndex((c) => c.hash === img.hash);
              return (
                <button
                  key={img.hash} type="button"
                  className={'mk-item' + (pos >= 0 ? ' picked' : '')}
                  onClick={() => toggle(img)}
                  disabled={pos < 0 && cards.length >= maxCards}
                  title={img.name}
                >
                  {pos >= 0 && <span className="ad-pos">{pos + 1}</span>}
                  <img className="mk-thumb" src={img.url} alt="" loading="lazy" />
                  <span className="mk-title">{img.title || img.name}</span>
                </button>
              );
            })}
          </div>
          </>)}
        </aside>

        <section className="mk-work">
          {mode === 'carousel' && (
          <div className="card">
            <div className="card-label">Carousel</div>
            <div className="field-row">
              <label className="field">
                <span>Name (for finding it in Ads Manager)</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. October lifestyle drop" />
              </label>
              <label className="field">
                <span>Button</span>
                <select className="input" value={cta} onChange={(e) => setCta(e.target.value)}>
                  {(config.ctaTypes || []).map((t) => <option key={t} value={t}>{CTA_LABELS[t] || t}</option>)}
                </select>
              </label>
            </div>
            {textBlock}
            <label className="check">
              <input type="checkbox" checked={reorder} onChange={(e) => setReorder(e.target.checked)} />
              Let Meta reorder the cards by performance
            </label>
            <label className="check">
              <input type="checkbox" checked={endCard} onChange={(e) => setEndCard(e.target.checked)} />
              Add an end card with the Page's profile picture
            </label>

            {cards.length === 0 && <div className="ledger-note" style={{ marginTop: 10 }}>Pick images from the library. Each one becomes a card, in the order you pick them.</div>}

            <div className="ad-cards">
              {cards.map((c, i) => (
                <div className="ad-card" key={c.hash}>
                  <div className="ad-card-media">
                    <span className="ad-pos static">{i + 1}</span>
                    <img src={c.url} alt="" />
                  </div>
                  <div className="ad-card-fields">
                    {lib.products.length > 0 && (
                      <select className="input" value={c.handle} onChange={(e) => pickProduct(c.hash, e.target.value)}>
                        <option value="">{c.handle ? 'Product not found' : 'Fill from a product...'}</option>
                        {lib.products.map((p) => <option key={p.handle} value={p.handle}>{p.title}</option>)}
                      </select>
                    )}
                    <input className="input" value={c.headline} placeholder="Headline" onChange={(e) => updateCard(c.hash, { headline: e.target.value })} />
                    <input className="input" value={c.link} placeholder="https://..." onChange={(e) => updateCard(c.hash, { link: e.target.value })} />
                    {c.headline.length > 40 && <div className="ledger-note">Long headline: Meta cuts carousel headlines off at around 40 characters.</div>}
                    {c.width && c.height && c.width !== c.height && (
                      <div className="ledger-note">Not square ({c.width}x{c.height}). Meta shows carousel cards square, so this will be cropped.</div>
                    )}
                  </div>
                  <div className="ad-card-actions">
                    <button className="btn btn-ghost" type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move earlier">&uarr;</button>
                    <button className="btn btn-ghost" type="button" onClick={() => move(i, 1)} disabled={i === cards.length - 1} title="Move later">&darr;</button>
                    <button className="btn btn-ghost" type="button" onClick={() => setCards((cs) => cs.filter((x) => x.hash !== c.hash))} title="Remove">&times;</button>
                  </div>
                </div>
              ))}
            </div>

            {cards.length > 0 && landingSection}

            {cards.length > 0 && problems.length > 0 && (
              <div className="mk-dests" style={{ marginTop: 12 }}>
                {problems.map((p) => (
                  <div className="mk-dest" key={p}><span className="mini-dot" style={{ background: 'var(--amber)' }} /><span>{p}</span></div>
                ))}
              </div>
            )}
            {error && <div className="login-error">{error}</div>}

            <div className="reply-actions" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={build} disabled={building || problems.length > 0}>
                {building ? 'Building...' : 'Build carousel (' + cards.length + ' card' + (cards.length === 1 ? '' : 's') + ')'}
              </button>
            </div>

            {result && (
              <div className="flag ok ad-done" style={{ marginTop: 14 }}>
                <span className="ico">&#10003;</span>
                <span>
                  Carousel built in ad account {result.accountId} (creative {result.id}
                  {result.postId ? ', post ' + result.postId : ''}).
                  {' '}Add it to an ad set below, or in Ads Manager create an ad and choose <b>Use existing post</b>.
                  {result.instagramDropped && <> Built without the Instagram account, so Instagram placements show the Facebook Page: Meta refused it with it ({result.instagramDropped}).</>}
                  {' '}{result.previewUrl && <a href={result.previewUrl} target="_blank" rel="noreferrer">Preview</a>}
                  {result.previewUrl && ' · '}
                  <a href={adsManager} target="_blank" rel="noreferrer">Open Ads Manager</a>
                </span>
              </div>
            )}
          </div>
          )}

          {mode === 'video' && (
            <div className="card">
              <div className="card-label">Video ad</div>
              {!design ? (
                <div className="ledger-note">Pick the reel you made in Canva from the list.</div>
              ) : (
                <>
                  <div className="mk-job-head">
                    {design.thumb && <img className="mk-job-thumb" src={design.thumb} alt="" />}
                    <div className="mk-job-title">
                      <div className="li-name">{design.title}</div>
                      <div className="li-sub">
                        {design.updated ? 'edited ' + fmtDay(design.updated) : ''}
                        {design.editUrl && <> · <a href={design.editUrl} target="_blank" rel="noreferrer">Open in Canva</a></>}
                      </div>
                    </div>
                  </div>
                  {ratio && (ratio < 1.7 || ratio > 1.85) && (
                    <div className="flag warn" style={{ marginTop: 0, marginBottom: 12 }}>
                      <span className="ico">&#9873;</span>
                      <span>This design is not 9:16, so it will not fill Reels and Stories. A Canva "Instagram Reel" design is the right size.</span>
                    </div>
                  )}

                  <div className="reply-actions" style={{ marginBottom: 10 }}>
                    <button className="btn btn-primary" type="button" onClick={sendVideo}
                      disabled={vStage === 'exporting' || vStage === 'uploading' || vStage === 'processing'}>
                      {vStage === 'ready' || vStage === 'failed' ? '\u21bb Send again' : vStage === 'idle' ? 'Send video to Meta' : 'Sending...'}
                    </button>
                    <span className="ledger-note">Exports the current version from Canva, so send again after editing it there.</span>
                  </div>
                  {vStage !== 'idle' && (
                    <div className="mk-dests" style={{ marginTop: 0, marginBottom: 12 }}>
                      {STAGES.map(([k, label], idx) => {
                        const at = STAGES.findIndex(([x]) => x === vStage);
                        const done = vStage === 'ready' || (at >= 0 && idx < at);
                        const now = k === vStage && vStage !== 'ready';
                        if (vStage === 'failed') return null;
                        return (
                          <div className="mk-dest" key={k}>
                            <span className="mini-dot" style={{ background: done ? 'var(--green)' : now ? 'var(--amber)' : 'var(--faint)' }} />
                            <span>{label}{now ? '...' + (k === 'processing' && vMsg ? ' ' + vMsg : '') : ''}</span>
                          </div>
                        );
                      })}
                      {vStage === 'failed' && (
                        <div className="mk-dest"><span className="mini-dot" style={{ background: 'var(--red)' }} /><span>{vMsg}</span></div>
                      )}
                    </div>
                  )}
                  {exportUrl && (
                    <video className="ad-video" src={exportUrl} controls playsInline muted preload="metadata" />
                  )}

                  <div className="field-row">
                    <label className="field">
                      <span>Name (for finding it in Ads Manager)</span>
                      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. October reel" />
                    </label>
                    <label className="field">
                      <span>Button</span>
                      <select className="input" value={cta} onChange={(e) => setCta(e.target.value)}>
                        {(config.ctaTypes || []).map((t) => <option key={t} value={t}>{CTA_LABELS[t] || t}</option>)}
                      </select>
                    </label>
                  </div>
                  {lib.products.length > 0 && (
                    <label className="field">
                      <span>Link to a product (or leave as the store)</span>
                      <select className="input" value={vHandle} onChange={(e) => pickVideoProduct(e.target.value)}>
                        <option value="">Fill from a product...</option>
                        {lib.products.map((p) => <option key={p.handle} value={p.handle}>{p.title}</option>)}
                      </select>
                    </label>
                  )}
                  <div className="field-row">
                    <label className="field">
                      <span>Headline (under the video)</span>
                      <input className="input" value={vHeadline} onChange={(e) => { setVHeadline(e.target.value); setResult(null); }} />
                    </label>
                    <label className="field">
                      <span>Link</span>
                      <input className="input" value={vLink} onChange={(e) => { setVLink(e.target.value); setResult(null); }} placeholder="https://..." />
                    </label>
                  </div>
                  {landingSection}
                  {textBlock}

                  {vProblems.length > 0 && (
                    <div className="mk-dests" style={{ marginTop: 4 }}>
                      {vProblems.map((p) => (
                        <div className="mk-dest" key={p}><span className="mini-dot" style={{ background: 'var(--amber)' }} /><span>{p}</span></div>
                      ))}
                    </div>
                  )}
                  {error && <div className="login-error">{error}</div>}
                  <div className="reply-actions" style={{ marginTop: 14 }}>
                    <button className="btn btn-primary" onClick={buildVideo} disabled={building || vProblems.length > 0}>
                      {building ? 'Building...' : 'Build video ad'}
                    </button>
                  </div>
                  {result && (
                    <div className="flag ok ad-done" style={{ marginTop: 14 }}>
                      <span className="ico">&#10003;</span>
                      <span>
                        Video ad built in ad account {result.accountId} (creative {result.id}{result.postId ? ', post ' + result.postId : ''}).
                        {' '}Add it to an ad set below.
                        {result.instagramDropped && <> Built without the Instagram account, so Instagram placements show the Facebook Page: Meta refused it with it ({result.instagramDropped}).</>}
                        {' '}{result.previewUrl && <a href={result.previewUrl} target="_blank" rel="noreferrer">Preview</a>}
                        {result.previewUrl && ' · '}
                        <a href={adsManager} target="_blank" rel="noreferrer">Open Ads Manager</a>
                      </span>
                    </div>
                  )}
                </>
              )}
              {!design && error && <div className="login-error">{error}</div>}
            </div>
          )}

          {attach && (
            <div className="card">
              <div className="card-label">Add to an ad set (paused)</div>
              <p className="pane-sub" style={{ marginTop: 0, marginBottom: 12 }}>
                Creates a new ad from <b>{attach.name}</b> in the ad set you pick, switched off. It spends nothing until you turn it on in Ads Manager, where the budget and targeting are.
              </p>
              <div className="pf-chips" role="group" aria-label="Which campaigns to show">
                {[['active', 'Active campaigns'], ['recent', 'Edited in the last ' + RECENT_DAYS + ' days'], ['all', 'All']].map(([k, label]) => (
                  <button key={k} type="button" className={'chip' + (adsetFilter === k ? ' active' : '')}
                    onClick={() => { setAdsetFilter(k); setAdsetId(''); setAdResult(null); }}>{label}</button>
                ))}
                <button type="button" className="chip" onClick={loadAdsets} disabled={adsetsLoading}
                  title="Reload campaigns and ad sets from Meta">
                  {adsetsLoading ? 'Refreshing...' : '\u21bb Refresh'}
                </button>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Campaign and ad set ({campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}, newest edit first)</span>
                  <select className="input" value={adsetId} onChange={(e) => { setAdsetId(e.target.value); setAdResult(null); }} disabled={adsetsLoading}>
                    <option value="">{adsetsLoading ? 'Loading...' : 'Pick an ad set'}</option>
                    {campaigns.map((c) => (
                      <optgroup key={c.key} label={c.name + (c.status && c.status !== 'ACTIVE' ? ' (' + c.status.toLowerCase() + ')' : '') + (c.edited ? ' · edited ' + fmtDay(c.edited) : '')}>
                        {c.sets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}{a.status && a.status !== 'ACTIVE' ? ' (' + a.status.toLowerCase().replace(/_/g, ' ') + ')' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Ad name</span>
                  <input className="input" value={adName} onChange={(e) => setAdName(e.target.value)} />
                </label>
              </div>
              {!adsetsLoading && adsets[brand] && adsets[brand].length === 0 && (
                <div className="ledger-note">This ad account has no ad sets yet. Create a campaign and ad set in Ads Manager first.</div>
              )}
              {!adsetsLoading && allCampaigns.length > 0 && campaigns.length === 0 && (
                <div className="ledger-note">No campaigns match this filter. Try another, or All.</div>
              )}
              {adError && <div className="login-error">{adError}</div>}
              <div className="reply-actions" style={{ marginTop: 6 }}>
                <button className="btn btn-primary" onClick={addToAdSet} disabled={adding || !adsetId || !!adResult}>
                  {adding ? 'Adding...' : adResult ? 'Added, paused' : 'Add as paused ad'}
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => setAttach(null)}>Close</button>
              </div>
              {adResult && (
                <div className="flag ok ad-done" style={{ marginTop: 12 }}>
                  <span className="ico">&#10003;</span>
                  <span>
                    Ad {adResult.id} created, paused. Turn it on in Ads Manager when you are ready.
                    {' '}<a href={adsManager + '&selected_ad_ids=' + adResult.id} target="_blank" rel="noreferrer">Open it in Ads Manager</a>
                  </span>
                </div>
              )}
            </div>
          )}

          {(recent[brand] || []).length > 0 && (
            <div className="card">
              <div className="card-label">Built here for {brandInfo ? brandInfo.name : brand}</div>
              {(recent[brand] || []).map((c) => (
                <div className="build-row" key={c.id}>
                  <span className="li-name">
                    {c.name}
                    <span className="li-sub">creative {c.id}{c.postId ? ' · post ' + c.postId : ''}</span>
                  </span>
                  {c.thumb && <img className="mk-job-thumb" src={c.thumb} alt="" />}
                  <button className="btn btn-ghost" type="button" onClick={() => startAttach({ id: c.id, name: c.name })}>Add to ad set</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
