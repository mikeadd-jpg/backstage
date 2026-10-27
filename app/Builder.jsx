'use client';
import { useEffect, useState } from 'react';
import { designFamily } from '../lib/colors';

// Product builder. One upload builds every product's listings:
//   - Global Fulfillment (Gildan, Comfort Colors): one Printify Choice listing made and
//     shipped locally in every market, limited to eligible colours. Per-market listings
//     are offered beside it, unticked, for a market-specific design.
//   - Everything else: one listing per market (US, CA, UK, AU), each tagged with its
//     market, on the printer lib/printers.js ranks best there. Every pick is overridable.
// One design goes on every colour unless "different design per colour" is on. Then each
// colour family picked anywhere (Black, Navy, Dark grey...) takes one front and back across
// every product, since each blank names its shades differently; a family can be split so a
// shade gets its own. Each row shows a preview of exactly what it will get, and the result
// lists the design each colour received.

const money = (cents) => (cents == null ? '?' : '$' + (cents / 100).toFixed(2));

// Printify quotes the smallest size with one print area. Cost rises with size and a back
// print adds about $5, so a single figure would read as the price of every shirt.
const range = (lo, hi) => (hi && hi > lo ? money(lo) + '–' + money(hi) : money(lo));
const landedRange = (c) => range((c.base || 0) + (c.ship ? c.ship.cost : 0),
  c.baseMax ? c.baseMax + (c.ship ? c.ship.cost : 0) : null);

// A candidate's colours: inline on the Global listing, else shared per product.
const colorsOf = (product, c) => (c ? c.colors || (product.printers && product.printers[c.id]) || [] : []);

function sizeRange(sizes) {
  return sizes.length > 2 ? sizes[0] + '–' + sizes[sizes.length - 1] : sizes.join(', ');
}

function deliveryText(c) {
  if (!c.ship) return 'does not ship here';
  const prod = Math.ceil(c.prodDays || 2);
  return (prod + c.ship.from) + '–' + (prod + c.ship.to) + ' days';
}

function Dot({ c }) {
  return <span className={'sw-dot' + (c.hex ? '' : ' sw-unknown')} style={c.hex ? { background: c.hex } : undefined} />;
}

// The full palette for one listing. Tap toggles a colour; the line above the grid names
// the colour just tapped (or hovered with a mouse), since a phone has no hover.
function Palette({ colors, selected, onChange, defaults, onCopy, copyLabel, onDone, note }) {
  const [active, setActive] = useState(null);
  const picked = new Set(selected);
  const shown = colors.find((c) => c.name === active);
  const variants = colors.reduce((n, c) => n + (picked.has(c.name) ? c.sizes.length : 0), 0);

  function toggle(name) {
    setActive(name);
    onChange(picked.has(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  }

  return (
    <div className="pal" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
      {note && <div className="pal-note">{note}</div>}
      <div className="pal-name">
        {shown
          ? <><Dot c={shown} /><b>{shown.name}</b> {sizeRange(shown.sizes)}{picked.has(shown.name) ? ' · picked' : ''}</>
          : <>{picked.size} picked &middot; {variants} variants. Tap to add or remove.</>}
      </div>
      <div className="sw-list pal-grid">
        {colors.map((c) => (
          <button
            type="button" key={c.name}
            className={'sw sw-pick' + (picked.has(c.name) ? ' sw-on' : '')}
            title={c.name + ' · ' + sizeRange(c.sizes)}
            aria-label={c.name}
            aria-pressed={picked.has(c.name)}
            // Hover only for a real mouse: a touch fires an emulated hover first.
            onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(c.name); }}
            onClick={() => toggle(c.name)}
          >
            <Dot c={c} />
          </button>
        ))}
      </div>
      <div className="pal-actions">
        <button type="button" className="pal-btn" onClick={() => onChange(colors.map((c) => c.name))}>All</button>
        <button type="button" className="pal-btn" onClick={() => onChange([])}>None</button>
        <button type="button" className="pal-btn" onClick={() => onChange(defaults.slice())}>Defaults</button>
        {onCopy && <button type="button" className="pal-btn" onClick={onCopy}>{copyLabel}</button>}
        <button type="button" className="pal-btn pal-done" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// Every printer for one market, best first, with what the ranking weighed.
function PrinterList({ product, candidates, pick, onPick, showBlank, onDone }) {
  return (
    <div className="pal">
      <div className="pal-note">
        Printify Choice when it prints in this market; otherwise the cheapest landed cost
        (base + shipping), unless one within $0.75 is faster or better rated. Greyed printers
        were filtered out; you can still pick any of them.
      </div>
      <div className="pr-list">
        {candidates.map((c) => (
          <button
            type="button" key={c.id}
            className={'pr' + (c.id === pick ? ' pr-on' : '') + (c.eligible ? '' : ' pr-out')}
            onClick={() => onPick(c)}
            disabled={!c.ship}
          >
            <span className="pr-top">
              <span className="pr-name">{c.name}</span>
              {c.picked && <span className="pr-score">recommended</span>}
              {!c.picked && c.delta != null && <span className="pr-score">{c.delta > 0 ? '+' + money(c.delta) : 'cheapest'}</span>}
            </span>
            <span className="pr-meta">
              {showBlank && <>{c.blank} &middot; </>}
              made in {c.madeIn.length ? c.madeIn.join(', ') : '?'}
              {c.rating != null && <> &middot; &#9733; {c.rating.toFixed(1)}</>}
            </span>
            <span className="pr-meta">
              {range(c.base, c.baseMax)} unit + {c.ship ? money(c.ship.cost) : '?'} ship = <b>{landedRange(c)}</b>
            </span>
            <span className="pr-meta">
              {deliveryText(c)} &middot; {c.colorCount ?? colorsOf(product, c).length} colours
            </span>
            {c.picked && c.why && <span className="pr-why">{c.why}</span>}
            {c.reason && <span className="pr-reason">{c.reason}</span>}
          </button>
        ))}
      </div>
      <div className="pal-actions">
        <button type="button" className="pal-btn pal-done" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// What every route to each market actually costs, so the pick can be checked rather than
// trusted. The Global Fulfillment row repeats per market on purpose: it is one listing,
// but the point is that its landed cost holds in each market while the alternatives do not.
function CostTable({ product, sel, onDone }) {
  const globalListing = product.listings.find((l) => l.market === 'GLOBAL');
  const gf = globalListing ? globalListing.candidates.find((c) => c.id === globalListing.pick) : null;
  const markets = product.listings.filter((l) => l.market !== 'GLOBAL');
  const gfLanded = gf ? (gf.base || 0) + (gf.ship ? gf.ship.cost : 0) : null;
  const gfDays = gf && gf.ship
    ? Math.ceil(gf.prodDays || 2) + gf.ship.from + '\u2013' + (Math.ceil(gf.prodDays || 2) + gf.ship.to) + ' days'
    : null;

  const Route = ({ label, c, landed, days, win, note }) => (
    <div className={'ctm-row' + (win ? ' ctm-win' : '')}>
      <span className="ctm-route">{label}{note && <span className="ctm-note"> {note}</span>}</span>
      <span className="ctm-landed">{landed}</span>
      <span className="ctm-detail">
        {c ? <>{range(c.base, c.baseMax)} unit + {c.ship ? money(c.ship.cost) : '?'} ship &middot; {days}</> : 'nothing ships here'}
      </span>
    </div>
  );

  return (
    <div className="pal">
      <div className="pal-note">
        Your Printify Premium cost, smallest to largest size, front print only. A back print
        adds about $5. Shipping is Printify's standard rate for one item.
      </div>
      {markets.map((l) => {
        const c = l.candidates.find((x) => x.id === (sel[l.market] || {}).pick);
        const mine = c ? (c.base || 0) + (c.ship ? c.ship.cost : 0) : null;
        const win = gfLanded != null && mine != null && gfLanded < mine;
        return (
          <div className="ctm" key={l.market}>
            <div className="ctm-head">{l.label}</div>
            {gf && (
              <Route label={'Global, printed in ' + l.market} c={gf} landed={landedRange(gf)} days={gfDays} win={win} />
            )}
            <Route
              label={c ? c.name : 'No printer'}
              c={c}
              landed={c ? landedRange(c) : '\u2014'}
              days={c ? Math.round(c.delivery) + ' days' : ''}
              win={gf && !win && mine != null}
              note={c && !c.local ? 'imported' : null}
            />
          </div>
        );
      })}
      {gf && (
        <div className="pal-note ct-foot">
          Global Fulfillment is one listing covering every market. The second row of each pair
          is that market's own listing, only needed for a design meant just for that market.
        </div>
      )}
      <div className="pal-actions">
        <button type="button" className="pal-btn pal-done" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// One listing of one product: Global, or one market.
function ListingRow({ product, listing, sel, onSel, open, setOpen, onCopy }) {
  const isGlobal = listing.market === 'GLOBAL';
  const cand = listing.candidates.find((c) => c.id === sel.pick) || null;
  const colors = colorsOf(product, cand);
  const byName = new Set(colors.map((c) => c.name));
  const chosen = colors.filter((c) => sel.colors.includes(c.name));
  const variants = chosen.reduce((n, c) => n + c.sizes.length, 0);
  const id = product.key + ':' + listing.market;
  const panel = open && open.startsWith(id + ':') ? open.slice(id.length + 1) : null;
  const toggle = (what) => setOpen(panel === what ? null : id + ':' + what);
  const blanks = new Set(listing.candidates.map((c) => c.blank));

  return (
    <div className={'rg' + (sel.on ? '' : ' rg-off') + (isGlobal ? ' rg-global' : '') + (listing.imported ? ' rg-import' : '')}>
      <div className="rg-head">
        <label className="check acc-region">
          <input type="checkbox" checked={sel.on} onChange={() => onSel({ ...sel, on: !sel.on })} />
          {isGlobal ? 'Global' : listing.market}
        </label>
        <span className="rg-tags">{listing.tags.map((t) => <span className="ctry" key={t}>{t}</span>)}</span>
        {listing.imported && <span className="rg-imported">imported</span>}
        {cand && (
          <span className="rg-actions">
            {!isGlobal && (
              <button type="button" className="pal-btn" onClick={() => toggle('printer')} aria-expanded={panel === 'printer'}>
                Printer
              </button>
            )}
            <button type="button" className="pal-btn" onClick={() => toggle('colours')} aria-expanded={panel === 'colours'}>
              Colours
            </button>
          </span>
        )}
      </div>

      {!cand && <div className="rg-line acc-note">No printer ships this here.</div>}
      {cand && (
        <div className="rg-line">
          <b>{cand.name}</b>
          {isGlobal
            ? <> &middot; made and shipped locally in US, CA, UK, AU and EU</>
            : <> &middot; {cand.local ? 'ships from inside ' + listing.market : 'ships in from ' + cand.madeIn.join('/')}</>}
          {cand.rating != null && <> &middot; &#9733; {cand.rating.toFixed(1)}</>}
          {' · '}{landedRange(cand)} landed ({range(cand.base, cand.baseMax)} unit + {cand.ship ? money(cand.ship.cost) : '?'} ship)
          {' · '}{deliveryText(cand)}
          {blanks.size > 1 && <> &middot; {cand.blank}</>}
          {!isGlobal && cand.picked && cand.why && <span className="rg-why">{cand.why}</span>}
        </div>
      )}
      {cand && (
        <button type="button" className="rg-strip" onClick={() => toggle('colours')} aria-label={'Edit colours for ' + listing.label}>
          {chosen.length === 0
            ? <span className="acc-note rg-warn">No colours picked</span>
            : chosen.map((c) => <span className="rg-dot" key={c.name} title={c.name}><Dot c={c} /></span>)}
          <span className="rg-count">{chosen.length} of {colors.length} &middot; {variants} variants</span>
        </button>
      )}

      {cand && panel === 'colours' && (
        <Palette
          colors={colors}
          selected={sel.colors.filter((n) => byName.has(n))}
          defaults={listing.defaults.filter((n) => byName.has(n))}
          onChange={(names) => onSel({ ...sel, colors: names })}
          onCopy={onCopy}
          copyLabel="Copy to other markets"
          onDone={() => setOpen(null)}
          note={isGlobal ? 'Only Global Fulfillment colours are shown. One ineligible colour would drop the whole listing to regular shipping.' : null}
        />
      )}
      {cand && panel === 'printer' && (
        <PrinterList
          product={product}
          candidates={listing.candidates}
          pick={sel.pick}
          showBlank={blanks.size > 1}
          onPick={(c) => {
            // A new printer has its own stock: keep what it carries, else its defaults.
            const have = new Set(colorsOf(product, c).map((x) => x.name));
            const kept = sel.colors.filter((n) => have.has(n));
            onSel({ ...sel, pick: c.id, colors: kept.length ? kept : listing.defaults.filter((n) => have.has(n)) });
          }}
          onDone={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Every colour picked on a ticked listing, by name (case-insensitive), with the products
// that use it and its family.
function pickedColours(products, picks) {
  const out = new Map();
  for (const p of products) {
    if (p.error || !picks[p.key]) continue;
    for (const l of p.listings) {
      const s = picks[p.key][l.market];
      if (!s || !s.on) continue;
      const cand = l.candidates.find((c) => c.id === s.pick);
      const stock = colorsOf(p, cand);
      for (const name of s.colors) {
        const k = name.toLowerCase();
        if (!out.has(k)) {
          out.set(k, { key: 'c:' + k, lower: k, name, family: designFamily(name),
            hex: (stock.find((c) => c.name === name) || {}).hex || null, products: new Set() });
        }
        out.get(k).products.add(p.label);
      }
    }
  }
  return [...out.values()].sort((a, b) => b.products.size - a.products.size || a.name.localeCompare(b.name));
}

// The upload rows: one per colour family present, its shades listed under it when split,
// then one per colour that is in no family. Upload keys: 'fam:<family>' and 'c:<colour>'.
function designRows(colours, split) {
  const rows = [];
  const fams = new Map();
  for (const c of colours) {
    if (!c.family) { rows.push({ key: c.key, label: c.name, colours: [c], hex: c.hex }); continue; }
    if (!fams.has(c.family.key)) {
      const row = { key: 'fam:' + c.family.key, label: c.family.label, colours: [], hex: c.hex, family: c.family.key };
      fams.set(c.family.key, row);
      rows.push(row);
    }
    fams.get(c.family.key).colours.push(c);
  }
  const out = [];
  for (const r of rows) {
    out.push(r);
    if (r.family && split.includes(r.family)) {
      for (const c of r.colours) out.push({ key: c.key, label: c.name, colours: [c], hex: c.hex, shadeOf: r });
    }
  }
  return out;
}

// What one colour gets for one side: its own upload (only while its family is split, so an
// un-split family never keeps a hidden shade override), else its family's, else null (the
// main design).
function resolvedFile(colourFiles, split, c, side) {
  const shaded = !c.family || split.includes(c.family.key);
  const own = shaded && (colourFiles[c.key] || {})[side];
  if (own) return { file: own, from: c.key };
  const fam = c.family && (colourFiles['fam:' + c.family.key] || {})[side];
  return fam ? { file: fam, from: 'fam:' + c.family.key } : null;
}

function Thumb({ file }) {
  if (!file) return null;
  return <img className="pc-thumb" alt="" src={'data:' + (file.type || 'image/png') + ';base64,' + file.b64} />;
}

function initialSelection(products) {
  const out = {};
  for (const p of products) {
    if (p.error) continue;
    out[p.key] = {};
    for (const l of p.listings) out[p.key][l.market] = { on: l.on && !!l.pick, pick: l.pick, colors: l.defaults.slice() };
  }
  return out;
}

export default function Builder() {
  const [stores, setStores] = useState([]);
  const [shopId, setShopId] = useState('');
  const [designName, setDesignName] = useState('');
  const [vibe, setVibe] = useState('');
  const [leftChest, setLeftChest] = useState(false);
  const [front, setFront] = useState(null);
  const [back, setBack] = useState(null);
  const [perColour, setPerColour] = useState(false);
  const [colourFiles, setColourFiles] = useState({}); // 'fam:<family>' | 'c:<colour>' -> { front, back }
  const [split, setSplit] = useState([]);            // family keys set shade by shade
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('adults');   // adults | kids
  const [catalog, setCatalog] = useState({ adults: null, kids: null });
  const [loadError, setLoadError] = useState({ adults: '', kids: '' });
  const [sel, setSel] = useState({ adults: {}, kids: {} }); // key -> market -> { on, pick, colors }
  const [open, setOpen] = useState(null);        // 'key:market:printer|colours'
  const [openAcc, setOpenAcc] = useState(true);
  const [progress, setProgress] = useState('');
  const [built, setBuilt] = useState([]);
  const [checkedAt, setCheckedAt] = useState({ adults: null, kids: null });

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      const s = d.stores || [];
      setStores(s);
      const def = s.find((x) => x.is_default) || s[0];
      if (def) setShopId(def.printify_shop_id);
    }).catch(() => {});

    // Printers, prices and colours come from the weekly saved copy (lib/printers.js), so
    // this is one quick request. Stock is checked again at build time.
    for (const g of ['adults', 'kids']) {
      fetch('/api/builder?group=' + g).then((r) => r.json()).then((d) => {
        if (d.error) return setLoadError((e) => ({ ...e, [g]: d.error }));
        setCatalog((c) => ({ ...c, [g]: d.products || [] }));
        setCheckedAt((c) => ({ ...c, [g]: d.checkedAt || null }));
        setSel((s) => ({ ...s, [g]: initialSelection(d.products || []) }));
      }).catch(() => setLoadError((e) => ({ ...e, [g]: 'Could not load printers from Printify.' })));
    }
  }, []);

  const products = catalog[mode] || [];
  const picks = sel[mode];
  const colours = perColour ? pickedColours(products, picks) : [];
  const rows = designRows(colours, split);
  const selectedCount = products.reduce((n, p) =>
    n + (p.error ? 0 : p.listings.filter((l) => picks[p.key] && picks[p.key][l.market] && picks[p.key][l.market].on).length), 0);

  function setListing(key, market, next) {
    setSel((s) => ({ ...s, [mode]: { ...s[mode], [key]: { ...s[mode][key], [market]: next } } }));
  }
  function toggleProduct(p) {
    const cur = picks[p.key] || {};
    const usable = p.listings.filter((l) => l.pick);
    const allOn = usable.every((l) => cur[l.market].on);
    const next = { ...cur };
    for (const l of usable) next[l.market] = { ...cur[l.market], on: !allOn };
    setSel((s) => ({ ...s, [mode]: { ...s[mode], [p.key]: next } }));
  }
  // Copy one listing's colours to the product's other market listings, keeping only what
  // each market's printer stocks. The Global listing is left alone: its colours are
  // limited to eligible ones on purpose.
  function copyToOthers(p, from) {
    const src = picks[p.key][from].colors;
    const next = { ...picks[p.key] };
    for (const l of p.listings) {
      if (l.market === from || l.market === 'GLOBAL') continue;
      const cand = l.candidates.find((c) => c.id === next[l.market].pick);
      if (!cand) continue;
      const have = new Set(colorsOf(p, cand).map((c) => c.name));
      next[l.market] = { ...next[l.market], colors: src.filter((n) => have.has(n)) };
    }
    setSel((s) => ({ ...s, [mode]: { ...s[mode], [p.key]: next } }));
  }

  async function pick(setter, file) {
    if (!file) { setter(null); return; }
    setter({ name: file.name, type: file.type, b64: await fileToB64(file) });
  }
  async function pickColour(key, side, file) {
    const img = file ? { name: file.name, type: file.type, b64: await fileToB64(file) } : null;
    setColourFiles((f) => ({ ...f, [key]: { ...f[key], [side]: img } }));
  }

  function switchMode(m) {
    setMode(m); setResult(null); setBuilt([]); setError(''); setOpen(null);
  }

  // One prepare call (upload + descriptions), then one call per product with all of its
  // ticked listings, so no request grows with the number of markets and results land
  // product by product.
  async function build() {
    setError(''); setResult(null); setBuilt([]); setProgress('');
    if (!shopId) return setError('Pick a store.');
    if (!designName.trim()) return setError('Enter a design name.');
    // Per colour, the main front only covers colours without their own, so it is needed
    // only while some picked colour has no front.
    const bare = perColour ? colours.filter((c) => !resolvedFile(colourFiles, split, c, 'front')) : [];
    if (!front && (!perColour || !colours.length)) return setError('Add a front design.');
    if (!front && bare.length) return setError('Add a main front design, or a front for ' + bare.map((c) => c.name).join(', ') + '.');
    if (selectedCount === 0) return setError('Pick at least one listing to build.');
    for (const p of products) {
      if (p.error) continue;
      for (const l of p.listings) {
        const s = picks[p.key][l.market];
        if (s.on && !s.colors.length) {
          return setError(p.label + ' ' + (l.market === 'GLOBAL' ? 'Global' : l.market) + ' has no colours picked. Pick some or untick it.');
        }
      }
    }
    setBusy(true);

    try {
      setProgress('Uploading the design and writing descriptions...');
      const prepRes = await fetch('/api/builder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'prepare', group: mode, shopId, designName, vibe,
          frontB64: front ? front.b64 : null, frontName: front ? front.name : null, perColour,
          backB64: back ? back.b64 : null, backName: back ? back.name : null,
        }),
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) { setError(prep.error || 'Prepare failed'); setBusy(false); return; }

      const allWarnings = [...(prep.warnings || [])];

      // Each row's files go up once, one per request (a request body has a size limit),
      // then every picked colour is given the id its own row resolves to. Uploaded ids are
      // named so the result can say which file each colour got.
      const fileNames = {};
      if (prep.frontId) fileNames[prep.frontId] = front.name + ' (main)';
      if (prep.backId) fileNames[prep.backId] = back.name + ' (main)';
      const uploaded = {};
      for (const r of rows) {
        const files = colourFiles[r.key] || {};
        for (const side of ['front', 'back']) {
          const f = files[side];
          if (!f) continue;
          setProgress('Uploading the ' + r.label + ' ' + side + ' design...');
          const res = await fetch('/api/builder', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'upload', group: mode, b64: f.b64, name: f.name, label: 'The ' + r.label + ' ' + side + ' design' }),
          });
          const d = await res.json();
          if (!res.ok) { setError(r.label + ' ' + side + ': ' + (d.error || 'upload failed')); setBusy(false); setProgress(''); return; }
          if (d.note) allWarnings.push(d.note);
          uploaded[r.key + ':' + side] = d.id;
          fileNames[d.id] = f.name;
        }
      }
      const colorDesigns = {};
      for (const c of colours) {
        const d = {};
        for (const side of ['front', 'back']) {
          const hit = resolvedFile(colourFiles, split, c, side);
          if (hit && uploaded[hit.from + ':' + side]) d[side + 'Id'] = uploaded[hit.from + ':' + side];
        }
        if (Object.keys(d).length) colorDesigns[c.lower] = d;
      }

      const collected = [];
      for (const p of products) {
        if (p.error) continue;
        const listings = p.listings
          .filter((l) => picks[p.key][l.market].on)
          .map((l) => {
            const s = picks[p.key][l.market];
            const c = l.candidates.find((x) => x.id === s.pick);
            return { market: l.market, providerId: c.providerId, blueprintId: c.blueprintId, colors: s.colors };
          });
        if (!listings.length) continue;
        setProgress('Building ' + p.label + ' (' + listings.map((l) => (l.market === 'GLOBAL' ? 'Global' : l.market)).join(', ') + ')...');
        const res = await fetch('/api/builder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'build', group: mode, shopId, key: p.key, designName, leftChest, listings,
            description: prep.descriptions[p.key], frontId: prep.frontId, backId: prep.backId, colorDesigns,
          }),
        });
        const d = await res.json();
        if (!res.ok) collected.push({ label: p.label, ok: false, error: d.error || 'Build failed' });
        else { collected.push(...d.results); allWarnings.push(...(d.warnings || [])); }
        setBuilt([...collected]);
      }
      setProgress('');
      setResult({ designName, storeName: prep.storeName, warnings: allWarnings, results: collected, fileNames });
    } catch (e) {
      setError('Something went wrong. Try again.');
      setProgress('');
    }
    setBusy(false);
  }

  return (
    <div className="pane">
      <div className="pane-head">Product Builder</div>
      <div className="tabs" style={{ marginBottom: 10 }}>
        <button className={'tab' + (mode === 'adults' ? ' active' : '')} onClick={() => switchMode('adults')}>Adults</button>
        <button className={'tab' + (mode === 'kids' ? ' active' : '')} onClick={() => switchMode('kids')}>Kids</button>
      </div>
      <p className="pane-sub">
        Upload one design and Backstage builds every listing as a Printify draft. Global
        Fulfillment products get one listing that ships locally everywhere; the rest get one
        listing per market on the best printer in that market, tagged us, ca, uk or au for
        Shopify Markets. Costs are your Printify Premium rates, smallest to largest size,
        for a front print; a back print adds about $5.
      </p>

      <div className="card">
        <label className="field">
          <span>Store</span>
          <select className="input" value={shopId} onChange={(e) => setShopId(e.target.value)}>
            {stores.length === 0 && <option value="">No stores yet, add one in Settings</option>}
            {stores.map((s) => <option key={s.printify_shop_id} value={s.printify_shop_id}>{s.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Design name</span>
          <input className="input" value={designName} onChange={(e) => setDesignName(e.target.value)} placeholder="e.g. Still Emo" />
        </label>

        <label className="field">
          <span>Vibe / notes (optional)</span>
          <input className="input" value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="what the design is about, tone, references" />
        </label>

        <div className="field-row">
          <label className="field">
            <span>{perColour ? 'Main front (optional if every colour has its own)' : 'Front design'}</span>
            <input type="file" accept="image/*" onChange={(e) => pick(setFront, e.target.files[0])} />
          </label>
          <label className="field">
            <span>{perColour ? 'Main back (optional)' : 'Back design (optional)'}</span>
            <input type="file" accept="image/*" onChange={(e) => pick(setBack, e.target.files[0])} />
          </label>
        </div>

        <label className="check">
          <input type="checkbox" checked={leftChest} onChange={(e) => setLeftChest(e.target.checked)} />
          Place front design as a small left-chest print
        </label>

        <label className="check">
          <input type="checkbox" checked={perColour} onChange={(e) => setPerColour(e.target.checked)} />
          Use a different design for some colours
        </label>
        {perColour && (
          <div className="pc">
            <div className="acc-note">
              One design per colour family across every ticked product: the Dark grey upload goes
              on Charcoal, Pepper, Coal and Dark Heather alike. Split a family to give a shade its
              own. Anything left empty gets the main front and back above.
            </div>
            {colours.length === 0 && <div className="acc-note">Tick some listings and colours below first.</div>}
            {rows.map((r) => {
              const files = colourFiles[r.key] || {};
              // What this row's colours will actually get, so a gap shows before the build.
              const sideState = (side, main) => {
                if (files[side]) return { file: files[side], text: files[side].name };
                const up = r.shadeOf && (colourFiles[r.shadeOf.key] || {})[side];
                if (up) return { file: up, text: 'uses the ' + r.shadeOf.label + ' design' };
                if (main) return { file: main, text: 'main design', warn: true };
                return { text: side === 'front' ? 'needed' : 'none', bad: side === 'front' };
              };
              const f = sideState('front', front);
              const b = sideState('back', back);
              return (
                <div className={'pc-row' + (r.shadeOf ? ' pc-shade' : '')} key={r.key}>
                  <div className="pc-name">
                    <Dot c={r} /> <b>{r.label}</b>
                    {!r.shadeOf && (
                      <span className="li-sub">
                        {' '}{r.family ? r.colours.map((c) => c.name).join(', ') + ' · ' : ''}
                        {[...new Set(r.colours.flatMap((c) => [...c.products]))].join(', ')}
                      </span>
                    )}
                    {r.shadeOf && <span className="li-sub"> {[...r.colours[0].products].join(', ')}</span>}
                    {r.family && r.colours.length > 1 && (
                      <button type="button" className="pal-btn"
                        onClick={() => setSplit((x) => (x.includes(r.family) ? x.filter((k) => k !== r.family) : [...x, r.family]))}>
                        {split.includes(r.family) ? 'One design for all' : 'Set shades separately'}
                      </button>
                    )}
                  </div>
                  <div className="field-row">
                    {[['front', 'Front', f], ['back', 'Back', b]].map(([side, label, st]) => (
                      <label className="field" key={side}>
                        <span className={st.bad ? 'rg-warn' : st.warn ? 'pc-warn' : ''}>{label}: {st.text}</span>
                        <span className="pc-pick">
                          <Thumb file={st.file} />
                          <input type="file" accept="image/*" onChange={(e) => pickColour(r.key, side, e.target.files[0])} />
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="acc">
          <button className="acc-head" onClick={() => setOpenAcc((o) => !o)} type="button">
            <span className="acc-caret">{openAcc ? '▾' : '▸'}</span>
            <span>Listings to build</span>
            <span className="acc-count">{selectedCount} selected</span>
          </button>

          {openAcc && (
            <div className="acc-body">
              {!catalog[mode] && !loadError[mode] && (
                <div className="ledger-note">Loading printers...</div>
              )}
              {loadError[mode] && <div className="login-error">{loadError[mode]}</div>}
              {checkedAt[mode] && (
                <div className="acc-note">
                  Printer prices from {new Date(checkedAt[mode]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, refreshed every Monday.
                </div>
              )}
              {products.map((p) => {
                if (p.error) {
                  return <div className="acc-group" key={p.key}><span className="li-name">{p.label}</span> <span className="acc-note">Could not load: {p.error}</span></div>;
                }
                const cur = picks[p.key] || {};
                const usable = p.listings.filter((l) => l.pick);
                const onCount = usable.filter((l) => cur[l.market] && cur[l.market].on).length;
                return (
                  <div className="acc-group" key={p.key}>
                    <label className="check acc-group-head">
                      <input
                        type="checkbox"
                        checked={usable.length > 0 && onCount === usable.length}
                        ref={(el) => { if (el) el.indeterminate = onCount > 0 && onCount < usable.length; }}
                        onChange={() => toggleProduct(p)}
                      />
                      <span className="li-name">{p.label}</span>
                      {p.blurb && <span className="li-sub acc-blurb">{p.blurb}</span>}
                    </label>
                    <button
                      type="button" className="pal-btn acc-costs"
                      onClick={() => setOpen(open === p.key + '::costs' ? null : p.key + '::costs')}
                      aria-expanded={open === p.key + '::costs'}
                    >
                      {open === p.key + '::costs' ? 'Hide costs' : 'Compare costs'}
                    </button>
                    {open === p.key + '::costs' && (
                      <CostTable product={p} sel={cur} onDone={() => setOpen(null)} />
                    )}
                    {p.globalMissing && (
                      <div className="acc-note acc-indent">Global Fulfillment could not be confirmed with Printify right now, so per-market listings are ticked instead.</div>
                    )}
                    {p.partial && <div className="acc-note acc-indent">Some printers did not answer; the list may be incomplete. Reload to retry.</div>}
                    {p.listings.some((l) => l.imported) && (
                      <div className="acc-note acc-indent">
                        No printer in {p.listings.filter((l) => l.imported).map((l) => l.market).join(', ')}.
                        Those ship in from abroad, so they start unticked.
                      </div>
                    )}
                    <div className="acc-regions">
                      {p.listings.map((l, i) => (
                        <div key={l.market} style={{ width: '100%' }}>
                          {p.globalCapable && !p.globalMissing && i === 1 && (
                            <div className="rg-divider">
                              {p.ownMarkets && p.ownMarkets.length
                                ? 'Per-market listings. Global leaves out ' + p.ownMarkets.join(', ') + ', so that one is ticked'
                                : 'Per-market listings, for a market-specific design'}
                            </div>
                          )}
                          <ListingRow
                            product={p}
                            listing={l}
                            sel={cur[l.market]}
                            onSel={(next) => setListing(p.key, l.market, next)}
                            open={open}
                            setOpen={setOpen}
                            onCopy={l.market === 'GLOBAL' ? null : () => copyToOthers(p, l.market)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary" onClick={build} disabled={busy || !catalog[mode]} style={{ marginTop: 8 }}>
          {busy
            ? 'Building ' + selectedCount + ' listing' + (selectedCount === 1 ? '' : 's') + '...'
            : 'Build ' + selectedCount + ' ' + (mode === 'kids' ? 'kids ' : '') + 'listing' + (selectedCount === 1 ? '' : 's')}
        </button>
        {busy && progress && <div className="ledger-note" style={{ marginTop: 8 }}>{progress}</div>}
      </div>

      {!result && built.length > 0 && (
        <div className="card">
          <div className="card-label">Progress</div>
          {built.map((r, i) => (
            <div className="build-row" key={i}>
              <span className="li-name">{r.label}</span>
              {r.ok
                ? <span className="status-pill s-shipped"><span className="mini-dot" style={{ background: 'var(--green)' }} />Created</span>
                : <span className="status-pill s-action" title={r.error}><span className="mini-dot" style={{ background: 'var(--red)' }} />Failed</span>}
            </div>
          ))}
        </div>
      )}

      {result && (
        <div className="card">
          <div className="card-label">Result: {result.designName} &rarr; {result.storeName}</div>
          {result.warnings && result.warnings.map((w, i) => (
            <div className="flag" key={i} style={{ marginBottom: 10 }}><span className="ico">&#9873;</span><span>{w}</span></div>
          ))}
          {result.results.map((r, i) => (
            <div className="build-row" key={i}>
              <span className="li-name">
                {r.label}{r.tags ? <span className="li-sub"> &middot; tags {r.tags.join(', ')}</span> : null}
                {r.designMap && r.designs > 1 && (
                  <span className="li-sub pc-map">
                    {Object.entries(r.designMap).map(([colour, d]) => colour + ': ' + (result.fileNames[d.front] || 'main')).join(' · ')}
                  </span>
                )}
              </span>
              {r.ok
                ? <span className="status-pill s-shipped"><span className="mini-dot" style={{ background: 'var(--green)' }} />Created{r.colors ? ' · ' + r.colors + ' colours' : ''}{r.variants ? ' · ' + r.variants + ' variants' : ''}{r.designs > 1 ? ' · ' + r.designs + ' designs' : ''}</span>
                : <span className="status-pill s-action" title={r.error}><span className="mini-dot" style={{ background: 'var(--red)' }} />Failed</span>}
            </div>
          ))}
          {result.results.some((r) => !r.ok) && (
            <div className="ledger-note" style={{ marginTop: 8 }}>
              {result.results.filter((r) => !r.ok).map((r) => r.label + ': ' + r.error).join(' · ')}
            </div>
          )}
          <p className="pane-sub" style={{ marginTop: 12 }}>Created as drafts. Review and publish them in Printify.</p>
        </div>
      )}
    </div>
  );
}
