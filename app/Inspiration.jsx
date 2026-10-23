'use client';
// Competitor ads from the Competitor Ads sheet, filled each morning by a scheduled task
// from the Meta Ad Library. Pick one, optionally paste a screenshot of it (the sheet only
// has the headline), and Claude says what it is doing and how to build our own version.
// "Make one like it" hands Claude's scene to the Mockups tab, where our real product is
// shot in it and reviewed like any other mockup. Breakdowns are held in this tab only.
import { useEffect, useMemo, useState } from 'react';

const PAGE = 60;
const SEED_KEY = 'backstage.mockupSeed'; // read once by app/Mockups.jsx
const TOOL_LABELS = { mockup: 'Lifestyle mockup', carousel: 'Carousel ad', video: 'Video ad from Canva' };

// Meta publishes no impressions for US commercial ads, so "winning" is inferred from the
// two things a competitor's spend does reveal: they keep paying for an ad that sells
// (days running), and they scale one by running copies of it (live ads from the same
// advertiser with the same headline). A guess, and the tab says so.
const WIN_DAYS = 30;      // still live after a month
const WIN_COPIES = 3;     // or scaled to three or more live copies
const COPY_WEIGHT = 10;   // one extra live copy counts like ten more days running
// Capped, because some advertisers launch 30+ copies of an ad on day one (Little Trouble
// did): that is how they set up, not proof it works, and uncapped it buried ads that have
// been live for three months.
const COPY_CAP = 10;

// Same advertiser, same headline once case, spacing and punctuation are ignored. Ads
// with no headline cannot be matched, so each stands alone.
function copyKey(ad) {
  const h = String(ad.headline || '').toLowerCase().replace(/[^\p{L}\p{N}$%]+/gu, ' ').trim();
  return h ? ad.competitor + '|' + h : 'id|' + ad.id;
}

// Screenshots go to Claude, which reads nothing past ~1568px on the long edge, so shrink
// before sending rather than paying to upload pixels nobody looks at.
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

function AdCard({ ad, open, onOpen }) {
  return (
    <div className={'card insp-ad' + (open ? ' open' : '')}>
      <div className="insp-ad-top">
        <span className="insp-comp">{ad.competitor}</span>
        {ad.starred && <span className="insp-star" title="Starred in the sheet">&#9733;</span>}
        {ad.winner && (
          <span className="insp-win" title="Likely winner: still running after a month, or scaled to several live copies. Inferred, since Meta does not publish impressions.">
            Likely winner
          </span>
        )}
        <span className={'insp-run' + (ad.active ? '' : ' ended')}>
          {ad.active
            ? (ad.copies > 1 ? ad.copies + ' copies · ' : '') + (ad.days > 0 ? ad.days + 'd' : 'new')
            : 'ended'}
        </span>
      </div>
      <div className="insp-headline">{ad.headline || <span className="ledger-note">No headline</span>}</div>
      {ad.text && <div className="insp-text">{ad.text}</div>}
      {ad.notes && <div className="insp-notes">Note: {ad.notes}</div>}
      <div className="insp-meta">Started {ad.startDate || '?'} · seen {ad.firstSeen}{ad.lastSeen && ad.lastSeen !== ad.firstSeen ? ' to ' + ad.lastSeen : ''}</div>
      <div className="reply-actions insp-actions">
        <a className="btn btn-ghost" href={ad.url} target="_blank" rel="noreferrer">Open in Ad Library</a>
        <button className={'btn ' + (open ? 'btn-ghost' : 'btn-primary')} onClick={onOpen}>
          {open ? 'Close' : 'How would I build this?'}
        </button>
      </div>
    </div>
  );
}

function Breakdown({ ad, brands, brand, setBrand, state, setState, go }) {
  const { image = '', recipe = null, busy = false, error = '', scene = '' } = state;
  const brandName = (brands.find((b) => b.key === brand) || {}).name || brand;

  async function pick(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try { setState({ image: await shrink(file), error: '' }); }
    catch (e) { setState({ error: e.message }); }
  }
  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); pick(item.getAsFile()); }
  }

  async function analyze() {
    setState({ busy: true, error: '' });
    try {
      const res = await fetch('/api/inspiration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', adId: ad.id, brand, image: image || undefined }),
      });
      const d = await res.json();
      if (!res.ok) return setState({ busy: false, error: d.error || 'Could not break that ad down.' });
      setState({ busy: false, recipe: d.recipe, scene: d.recipe.scene, recipeBrand: brand });
    } catch {
      setState({ busy: false, error: 'Request failed.' });
    }
  }

  // The Mockups tab picks this up on load: same store, this scene for the next products
  // picked, and the product hint as its search.
  function makeOne() {
    try {
      sessionStorage.setItem(SEED_KEY, JSON.stringify({
        brand: state.recipeBrand || brand, scene, search: recipe.product || '',
        source: ad.competitor + ': ' + (ad.headline || 'ad ' + ad.id).slice(0, 120),
      }));
    } catch {}
    go('mockups');
  }

  return (
    <div className="card insp-detail" onPaste={onPaste}>
      <div className="field-row">
        <label className="field">
          <span>Our store to adapt it for</span>
          <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
            {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
          </select>
        </label>
      </div>

      <div
        className={'insp-drop' + (image ? ' has' : '')}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
      >
        {image ? (
          <>
            <img src={image} alt="Screenshot of the competitor ad" />
            <button className="btn btn-ghost" onClick={() => setState({ image: '' })}>Remove screenshot</button>
          </>
        ) : (
          <>
            <span>Optional: paste, drop or choose a screenshot of the ad. Without one, Claude has only the headline.</span>
            <label className="btn btn-ghost">
              Choose image
              <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files[0])} />
            </label>
          </>
        )}
      </div>

      {error && <div className="login-error">{error}</div>}
      <div className="reply-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={analyze} disabled={busy || !brand}>
          {busy ? 'Reading the ad...' : recipe ? 'Break it down again' : 'Break it down for ' + brandName}
        </button>
      </div>

      {recipe && (
        <div className="insp-recipe">
          <dl className="insp-facts">
            <dt>Format</dt><dd>{recipe.format || 'unknown'}</dd>
            <dt>Hook</dt><dd>{recipe.hook}</dd>
            <dt>Why it works</dt><dd>{recipe.why}</dd>
          </dl>

          <div className="insp-sub">Build it as: {TOOL_LABELS[recipe.tool]}</div>
          <p className="insp-p">{recipe.toolWhy}</p>
          <ol className="insp-steps">{recipe.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>

          {recipe.headlines.length > 0 && (
            <>
              <div className="insp-sub">Headline ideas</div>
              <ul className="insp-steps">{recipe.headlines.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}

          <div className="insp-sub">Don't copy</div>
          <p className="insp-p">{recipe.avoid}</p>

          <label className="field" style={{ marginTop: 6 }}>
            <span>Scene for Mockups{recipe.product ? ' · use a product like: ' + recipe.product : ''}</span>
            <textarea className="input" rows={5} value={scene} onChange={(e) => setState({ scene: e.target.value })} />
          </label>
          <div className="reply-actions">
            <button className="btn btn-primary" onClick={makeOne} disabled={!scene.trim()}>Make one like it in Mockups</button>
            {recipe.tool !== 'mockup' && (
              <button className="btn btn-ghost" onClick={() => go('ads')}>Open Ads</button>
            )}
          </div>
          <div className="ledger-note" style={{ marginTop: 8 }}>
            Mockups opens on {(brands.find((b) => b.key === (state.recipeBrand || brand)) || {}).name || 'that store'} with this scene ready for the next products you pick. Nothing is generated until you press Generate there.
          </div>
        </div>
      )}
    </div>
  );
}

export default function Inspiration({ go }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [sheet, setSheet] = useState(null);

  const [competitor, setCompetitor] = useState('');
  const [show, setShow] = useState('active');   // active | all | starred
  const [sort, setSort] = useState('winners');  // winners | newest | longest
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const [openId, setOpenId] = useState(null);
  const [states, setStates] = useState({});     // ad id -> breakdown state, this tab only

  function load(refresh) {
    setLoading(true); setError('');
    fetch('/api/inspiration' + (refresh ? '?refresh=1' : ''))
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        setBrands(d.brands || []);
        setSheet(d.sheetUrl || null);
        setBrand((b) => b || (d.brands && d.brands[0] && d.brands[0].key) || '');
        if (!ok) setError(d.error || 'Could not read the Competitor Ads sheet.');
        else setData(d);
      })
      .catch(() => setError('Could not read the Competitor Ads sheet.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(false); }, []);

  // Each ad gets its copy count (live ads sharing its key), a score and the winner flag.
  const ads = useMemo(() => {
    const raw = data ? data.ads : [];
    const live = {};
    for (const a of raw) if (a.active) { const k = copyKey(a); live[k] = (live[k] || 0) + 1; }
    return raw.map((a) => {
      const key = copyKey(a);
      const copies = a.active ? live[key] : 0;
      return {
        ...a, key, copies,
        score: a.active ? a.days + COPY_WEIGHT * Math.min(copies - 1, COPY_CAP) : -1,
        winner: a.active && (a.days >= WIN_DAYS || copies >= WIN_COPIES),
      };
    });
  }, [data]);
  const competitors = useMemo(() => Array.from(new Set(ads.map((a) => a.competitor))).sort((a, b) => a.localeCompare(b)), [ads]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = ads.filter((a) => {
      if (competitor && a.competitor !== competitor) return false;
      if (show === 'active' && !a.active) return false;
      if (show === 'starred' && !a.starred) return false;
      if (q && !(a.headline + ' ' + a.text + ' ' + a.notes + ' ' + a.competitor).toLowerCase().includes(q)) return false;
      return true;
    });
    // Likely winners shows one card per set of copies (the longest running), so fifteen
    // copies of one Emo Nite ad do not fill the first screen, and only flagged winners.
    if (sort === 'winners') {
      const best = {};
      for (const a of list) {
        if (!a.winner) continue;
        if (!best[a.key] || a.days > best[a.key].days) best[a.key] = a;
      }
      return Object.values(best).sort((a, b) => b.score - a.score || b.days - a.days);
    }
    // Long-running ads first is the useful view: an ad still live after weeks is one the
    // competitor keeps paying for, so it is probably working.
    return list.sort(sort === 'longest'
      ? (a, b) => b.days - a.days || b.startDate.localeCompare(a.startDate)
      : (a, b) => b.startDate.localeCompare(a.startDate) || b.days - a.days);
  }, [ads, competitor, show, sort, search]);
  useEffect(() => { setLimit(PAGE); }, [competitor, show, sort, search]);

  const latest = data && data.digest && data.digest[0];
  const setStateFor = (id) => (patch) => setStates((s) => ({ ...s, [id]: { ...(s[id] || {}), ...patch } }));

  return (
    <div className="pane insp-pane">
      <div className="pane-head">Inspiration</div>
      <p className="pane-sub">
        Competitors' running Meta ads, refreshed every morning from the Ad Library. Pick one to see how we could make our own version.
        {sheet && <> Edit the competitor list, star ads or add notes in <a href={sheet} target="_blank" rel="noreferrer">the Competitor Ads sheet</a>.</>}
      </p>

      {error && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span><span>{error}</span>
        </div>
      )}

      {latest && latest.patterns && (
        <div className="card insp-digest">
          <div className="insp-sub" style={{ marginTop: 0 }}>What competitors are doing · {latest.date}</div>
          <p className="insp-p">{latest.patterns}</p>
          <div className="ledger-note">{latest.checked} competitors checked, {latest.newAds} new ads, {latest.running} running.</div>
        </div>
      )}

      <div className="card insp-filters">
        <div className="field-row">
          <label className="field">
            <span>Competitor</span>
            <select className="input" value={competitor} onChange={(e) => setCompetitor(e.target.value)}>
              <option value="">All competitors</option>
              {competitors.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Show</span>
            <select className="input" value={show} onChange={(e) => setShow(e.target.value)}>
              <option value="active">Still running</option>
              <option value="all">All, including ended</option>
              <option value="starred">Starred</option>
            </select>
          </label>
          <label className="field">
            <span>Sort</span>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="winners">Likely winners</option>
              <option value="newest">Newest first</option>
              <option value="longest">Running longest first</option>
            </select>
          </label>
          <label className="field">
            <span>Search</span>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="headline, note or brand" />
          </label>
        </div>
        <div className="reply-actions" style={{ marginTop: -6 }}>
          <span className="acc-count">
            {loading ? 'loading...'
              : sort === 'winners'
                ? filtered.length + ' likely winners, one card per set of copies. Inferred from days running and live copies; Meta does not publish impressions.'
                : filtered.length + ' of ' + ads.length + ' ads'}
          </span>
          <button className="btn btn-ghost" onClick={() => load(true)} disabled={loading}>Refresh</button>
        </div>
      </div>

      {!loading && !error && filtered.length === 0 && (
        <div className="ledger-note mk-empty">No ads match. The sheet fills each morning; check the filters or the competitor list.</div>
      )}

      <div className="insp-grid">
        {filtered.slice(0, limit).map((ad) => (
          <div key={ad.id} className={openId === ad.id ? 'insp-cell wide' : 'insp-cell'}>
            <AdCard ad={ad} open={openId === ad.id} onOpen={() => setOpenId(openId === ad.id ? null : ad.id)} />
            {openId === ad.id && (
              <Breakdown ad={ad} brands={brands} brand={brand} setBrand={setBrand}
                state={states[ad.id] || {}} setState={setStateFor(ad.id)} go={go} />
            )}
          </div>
        ))}
      </div>
      {filtered.length > limit && (
        <div className="reply-actions" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, filtered.length - limit)} more</button>
        </div>
      )}
    </div>
  );
}
