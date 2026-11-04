'use client';
// The ad brief: what an ad will be, read and approved before anything is spent. Started
// from a competitor ad (Claude's breakdown fills it in) or from scratch or a saved
// template. The person sets the idea, what they want in the ad, headline ideas, image or
// video, shape, layout and what goes over the picture, and picks the products and
// pictures: lifestyle shots already in Meta or Drafts, the store's own mockups, and how
// many new shots to make of each. "Approve and make" hands it to lib/recreate.js
// (createApprovedBrief), which uses exactly that; "Save as template" keeps everything but
// the products for next time. Nothing is generated before the approve button.
import { useEffect, useMemo, useState } from 'react';
import AdProducts from './AdProducts.jsx';
import { STILL_TEMPLATES, STILL_KEYS, PRESENTATIONS } from '../lib/stillPlans.js';

const OVERLAYS = { headline: 'Headline', sub: 'Line under', benefits: 'Benefits with icons', price: 'Price tags', button: 'Button', logo: 'Logo' };
const IMAGE_COST = 0.25;
const blank = { idea: '', direction: '', headlines: '', make: 'image', aspect: '', layout: '', overlays: ['headline', 'logo'], presentation: '', scene: '', composition: '', avoid: '' };

async function api(path, payload) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Request failed.');
  return d;
}

// A competitor breakdown as a brief.
export function briefFromRecipe(r) {
  return {
    idea: r.hook || '', direction: '', headlines: (r.headlines || []).join('\n'),
    make: r.tool === 'video' ? 'video' : 'image', aspect: '', layout: r.layout || '',
    overlays: r.overlays && r.overlays.length ? r.overlays : ['headline', 'logo'],
    presentation: r.presentation || '', scene: r.scene || '', composition: r.composition || '', avoid: r.avoid || '',
  };
}

const keyOf = (p) => p.hash || (p.draftId ? 'd' + p.draftId : p.url);

export default function BriefEditor({ brands, brand: startBrand, initial = null, source = null, productHint = '', onStarted, onClose }) {
  const [brand, setBrand] = useState(startBrand || (brands[0] && brands[0].key) || '');
  const [b, setB] = useState({ ...blank, ...(initial || {}) });
  const [lib, setLib] = useState(null);
  const [libError, setLibError] = useState('');
  const [chosen, setChosen] = useState({});            // productId -> { product, pictures: {key: pic}, newShots, color }
  const [pickCount, setPickCount] = useState(1);
  const [templates, setTemplates] = useState([]);
  const [tplName, setTplName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (patch) => { setB((x) => ({ ...x, ...patch })); setDone(false); };

  useEffect(() => {
    let live = true;
    setLib(null); setLibError(''); setChosen({});
    api('/api/ads', { action: 'library', brand }).then((d) => { if (live) setLib(d); }).catch((e) => { if (live) setLibError(e.message); });
    api('/api/recreate', { action: 'templates', brand }).then((d) => { if (live) setTemplates(d.templates || []); }).catch(() => {});
    return () => { live = false; };
  }, [brand]);

  const list = Object.values(chosen);
  const newShots = list.reduce((n, c) => n + c.newShots, 0);
  const picCount = list.reduce((n, c) => n + Object.keys(c.pictures).length, 0);
  const needsScene = newShots > 0 || list.length === 0;
  const spend = (list.length ? newShots : pickCount) * IMAGE_COST;

  const isPicked = (pic) => !!(chosen[pic.productId] && chosen[pic.productId].pictures[keyOf(pic)]);
  function entryFor(product, cur) {
    const colors = product.colors || [];
    return cur[product.id] || { product, pictures: {}, newShots: 0, color: product.defaultColor || (colors[0] && colors[0].name) || '' };
  }
  function togglePic(pic) {
    const product = (lib.products || []).find((p) => p.id === pic.productId);
    if (!product) return;
    setChosen((cur) => {
      const e = entryFor(product, cur);
      const pictures = { ...e.pictures };
      if (pictures[keyOf(pic)]) delete pictures[keyOf(pic)]; else pictures[keyOf(pic)] = pic;
      const next = { ...cur, [product.id]: { ...e, pictures } };
      if (!Object.keys(pictures).length && !e.newShots) delete next[product.id];
      return next;
    });
    setDone(false);
  }
  function useProduct(product) {
    setChosen((cur) => {
      const e = entryFor(product, cur);
      return { ...cur, [product.id]: { ...e, newShots: e.newShots || 1 } };
    });
    setDone(false);
  }
  function setEntry(id, patch) {
    setChosen((cur) => {
      const e = { ...cur[id], ...patch };
      const next = { ...cur, [id]: e };
      if (!Object.keys(e.pictures).length && !e.newShots) delete next[id];
      return next;
    });
    setDone(false);
  }

  function loadTemplate(id) {
    const t = templates.find((x) => String(x.id) === String(id));
    if (!t) return;
    const tb = t.brief || {};
    set({ ...blank, ...tb, headlines: Array.isArray(tb.headlines) ? tb.headlines.join('\n') : tb.headlines || '' });
    setTplName(t.name);
    setMsg('Loaded "' + t.name + '". Pick the products for this one.');
  }
  async function saveTemplate() {
    setMsg('');
    try {
      const d = await api('/api/recreate', { action: 'save-template', brand, name: tplName, brief: b });
      setTemplates((ts) => [d.template, ...ts.filter((t) => t.name !== d.template.name)]);
      setMsg('Saved as the template "' + d.template.name + '".');
    } catch (e) { setMsg(e.message); }
  }
  async function deleteTemplate(id) {
    const t = templates.find((x) => String(x.id) === String(id));
    if (!t || !window.confirm('Delete the template "' + t.name + '"?')) return;
    try { await api('/api/recreate', { action: 'delete-template', id }); setTemplates((ts) => ts.filter((x) => x.id !== t.id)); } catch (e) { setMsg(e.message); }
  }

  async function approve() {
    setBusy(true); setMsg('');
    try {
      await api('/api/recreate', {
        action: 'approve', brand, source, pickCount,
        brief: { ...b, headlines: String(b.headlines || '').split('\n') },
        products: list.map((c) => ({
          productId: c.product.id, newShots: c.newShots, color: c.color,
          pictures: Object.values(c.pictures).map((p) => (p.source === 'draft' ? { draftId: p.draftId } : { url: p.url })),
        })),
      });
      setDone(true);
      onStarted && onStarted();
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  const layouts = useMemo(() => STILL_KEYS.map((k) => [k, STILL_TEMPLATES[k].label]), []);

  return (
    <div className="brief">
      <div className="brief-head">
        <div className="card-label" style={{ margin: 0 }}>Ad brief</div>
        {onClose && <button type="button" className="link-inline" onClick={onClose}>Close</button>}
      </div>
      <p className="ledger-note" style={{ marginTop: 0 }}>
        {source ? 'Filled in from the competitor ad. ' : ''}Check it, change anything, pick the products and pictures, then approve. Nothing is made until you do.
      </p>

      <div className="field-row">
        <label className="field">
          <span>Store</span>
          <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
            {brands.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Start from a template</span>
          <div className="si-color">
            <select className="input" value="" onChange={(e) => loadTemplate(e.target.value)} disabled={!templates.length}>
              <option value="">{templates.length ? 'Pick a saved brief...' : 'No templates yet'}</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </label>
      </div>

      <label className="field">
        <span>The idea</span>
        <textarea className="input" rows={2} value={b.idea} onChange={(e) => set({ idea: e.target.value })} placeholder="e.g. A map of the place you met, framed, as an anniversary gift" />
      </label>
      <label className="field">
        <span>What you want in the ad</span>
        <textarea className="input" rows={3} value={b.direction} onChange={(e) => set({ direction: e.target.value })}
          placeholder="e.g. Use the headline 'Where it all began.' Mention free shipping. Warm and quiet, no people." />
      </label>
      <label className="field">
        <span>Headline ideas (one per line; write "use this headline exactly" above to fix one)</span>
        <textarea className="input" rows={3} value={b.headlines} onChange={(e) => set({ headlines: e.target.value })} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Make</span>
          <select className="input" value={b.make} onChange={(e) => set({ make: e.target.value })}>
            <option value="image">An image ad</option>
            <option value="video">A video ad</option>
          </select>
        </label>
        <label className="field">
          <span>Shape</span>
          <select className="input" value={b.aspect} onChange={(e) => set({ aspect: e.target.value })}>
            <option value="">{b.make === 'video' ? 'Default (9:16)' : 'Default (4:5)'}</option>
            <option value="4:5">4:5 feed</option>
            <option value="1:1">1:1 square</option>
            <option value="9:16">9:16 Stories and Reels</option>
          </select>
        </label>
        {b.make === 'image' && (
          <label className="field">
            <span>Layout</span>
            <select className="input" value={b.layout} onChange={(e) => set({ layout: e.target.value })}>
              <option value="">Claude chooses</option>
              {layouts.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="brief-checks">
        <span className="ledger-note">Over the picture:</span>
        {Object.entries(OVERLAYS).map(([k, v]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={b.overlays.includes(k)} onChange={(e) => set({ overlays: e.target.checked ? [...b.overlays, k] : b.overlays.filter((x) => x !== k) })} /> {v}
          </label>
        ))}
      </div>
      {b.overlays.includes('price') && <div className="ledger-note">Price tags only show prices your store's ad notes state.</div>}

      <div className="card-label" style={{ margin: '14px 0 6px' }}>Products and pictures</div>
      {list.length > 0 ? (
        <div className="brief-chosen">
          {list.map((c) => (
            <div key={c.product.id} className="brief-prod">
              <div className="brief-prod-head">
                <img src={c.product.image} alt="" />
                <div className="li-name">{c.product.title}</div>
                <button type="button" className="link-inline" onClick={() => setChosen((cur) => { const n = { ...cur }; delete n[c.product.id]; return n; })}>Remove</button>
              </div>
              <div className="brief-pics">
                {Object.entries(c.pictures).map(([k, p]) => (
                  <button key={k} type="button" className="brief-pic" onClick={() => togglePic(p)} title="Remove">
                    <img src={p.url} alt="" /><span>×</span>
                  </button>
                ))}
              </div>
              <div className="field-row">
                <label className="field">
                  <span>New lifestyle shots</span>
                  <select className="input" value={c.newShots} onChange={(e) => setEntry(c.product.id, { newShots: Number(e.target.value) })}>
                    {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 0 ? 'None, use the pictures picked' : n}</option>)}
                  </select>
                </label>
                {c.newShots > 0 && (c.product.colors || []).length > 1 && (
                  <label className="field">
                    <span>Colour</span>
                    <select className="input" value={c.color} onChange={(e) => setEntry(c.product.id, { color: e.target.value })}>
                      {c.product.colors.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="field-row">
          <label className="field">
            <span>No products picked: Claude picks from the store</span>
            <select className="input" value={pickCount} onChange={(e) => setPickCount(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} product{n > 1 ? 's' : ''}, one new shot each</option>)}
            </select>
          </label>
        </div>
      )}

      <div className="brief-picker">
        {libError ? <div className="login-error">{libError}</div> : !lib ? <div className="ledger-note">Loading the store's products...</div> : (
          <AdProducts brand={brand} lib={lib} isPicked={isPicked} onPick={togglePic} busy={false} initialQuery={productHint}
            onDraftMade={(handle, d) => setLib((l) => ({ ...l, drafts: { ...(l.drafts || {}), [handle]: [d, ...((l.drafts || {})[handle] || [])] } }))}
            onUseProduct={useProduct} productNote={(p) => (chosen[p.id] ? 'In the brief (' + (chosen[p.id].newShots || 0) + ' new, ' + Object.keys(chosen[p.id].pictures).length + ' picked)' : '')} />
        )}
      </div>

      {needsScene && (
        <>
          <label className="field" style={{ marginTop: 12 }}>
            <span>How the product is shown</span>
            <select className="input" value={b.presentation} onChange={(e) => set({ presentation: e.target.value })}>
              <option value="">As the scene says</option>
              {Object.entries(PRESENTATIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Scene for the new shots</span>
            <textarea className="input" rows={3} value={b.scene} onChange={(e) => set({ scene: e.target.value })} placeholder="Where it is, the light, the mood. Never the artwork." />
          </label>
          <label className="field">
            <span>Composition (where the product sits, where the words go)</span>
            <textarea className="input" rows={2} value={b.composition} onChange={(e) => set({ composition: e.target.value })}
              placeholder="e.g. Straight on, print on the right half, the top third plain wall for the words." />
          </label>
        </>
      )}
      {(source || b.avoid) && (
        <label className="field">
          <span>Don't copy</span>
          <textarea className="input" rows={2} value={b.avoid} onChange={(e) => set({ avoid: e.target.value })} />
        </label>
      )}

      <div className="reply-actions" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" type="button" onClick={approve} disabled={busy || (!b.idea.trim() && !b.direction.trim())}>
          {busy ? 'Starting...' : done ? 'Make another from this brief' : 'Approve and make'}
        </button>
        <span className="ledger-note">
          {list.length ? picCount + ' picture' + (picCount === 1 ? '' : 's') + ' picked, ' + newShots + ' new shot' + (newShots === 1 ? '' : 's') : pickCount + ' new shot' + (pickCount === 1 ? '' : 's')}
          {spend ? ' · about $' + spend.toFixed(2) : ' · no image cost'}
        </span>
      </div>
      {done && <div className="ledger-note" style={{ marginTop: 6 }}>Approved. It shows under Batches at the top of Inspiration and lands in Drafts, rendered, in a couple of minutes.</div>}

      <div className="brief-tpl">
        <input className="input" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Template name, e.g. Benefits poster" />
        <button className="btn btn-ghost" type="button" onClick={saveTemplate} disabled={!tplName.trim()}>Save as template</button>
        {templates.some((t) => t.name === tplName.trim()) && (
          <button className="btn btn-ghost" type="button" onClick={() => deleteTemplate((templates.find((t) => t.name === tplName.trim()) || {}).id)}>Delete template</button>
        )}
      </div>
      <div className="ledger-note">A template keeps everything above except the products, for this store.</div>
      {msg && <div className="ledger-note" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}
