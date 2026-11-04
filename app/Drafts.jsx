'use client';
// Every mockup, video ad and image ad the creative tools have made, kept until deleted
// (lib/drafts.js), so nothing is lost when a tab closes and the same work shows on any
// device. Favourite the keepers, delete the rest, download a file, or reopen a video or
// image draft in its builder in the Ads tab to keep editing it.
import { useEffect, useMemo, useState } from 'react';
import { OPEN_DRAFT_KEY } from './draftsClient.js';
import { BRANDS } from './ui';

const KIND_LABELS = { mockup: 'Mockup', video: 'Video ad', image: 'Image ad' };
const PAGE = 48;

const when = (iso) => {
  const d = new Date(iso);
  const days = Math.round((Date.now() - d) / 86400000);
  return days < 1 ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : days < 7 ? days + 'd ago' : d.toLocaleDateString();
};

async function post(body) {
  const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Request failed.');
  return d;
}

function Preview({ d }) {
  const o = d.output;
  if (o && /^video\//.test(o.contentType || '')) return <video className="dr-media" src={o.url} controls playsInline preload="metadata" />;
  if (o) return <img className="dr-media" src={o.url} alt="" loading="lazy" />;
  // Not rendered yet: the first picture it uses stands in.
  const pic = (d.assets || []).find((a) => a.kind === 'image');
  return (
    <div className="dr-media dr-unrendered">
      {pic && <img src={pic.url} alt="" loading="lazy" />}
      <span>Not rendered yet</span>
    </div>
  );
}

export default function Drafts({ go }) {
  const [drafts, setDrafts] = useState(null);
  const [kinds, setKinds] = useState([]);
  const [error, setError] = useState('');
  const [brand, setBrand] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(PAGE);

  function load() {
    setError('');
    fetch('/api/drafts').then((r) => r.json().then((d) => ({ ok: r.ok, d }))).then(({ ok, d }) => {
      if (!ok) return setError(d.error || 'Could not load drafts.');
      setDrafts(d.drafts || []); setKinds(d.kinds || []);
    }).catch(() => setError('Could not load drafts.'));
  }
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => (drafts || []).filter((d) => (!brand || d.brand === brand) && (!kind || d.kind === kind) && (!status || d.status === status)), [drafts, brand, kind, status]);
  const brandsSeen = useMemo(() => Array.from(new Set((drafts || []).map((d) => d.brand))), [drafts]);
  useEffect(() => { setLimit(PAGE); }, [brand, kind, status]);

  async function toggleFav(d) {
    const next = d.status === 'favorite' ? 'draft' : 'favorite';
    setDrafts((xs) => xs.map((x) => (x.id === d.id ? { ...x, status: next } : x)));
    try { await post({ action: 'status', id: d.id, status: next }); } catch (e) { setError(e.message); load(); }
  }
  async function remove(d) {
    if (!window.confirm('Delete "' + (d.title || KIND_LABELS[d.kind]) + '"? Its files are removed too.')) return;
    setDrafts((xs) => xs.filter((x) => x.id !== d.id));
    try { await post({ action: 'delete', id: d.id }); } catch (e) { setError(e.message); load(); }
  }
  function open(d) {
    try { sessionStorage.setItem(OPEN_DRAFT_KEY, JSON.stringify({ id: d.id })); } catch { /* the Ads tab just opens empty */ }
    go('ads');
  }

  return (
    <div className="pane">
      <div className="pane-head">Drafts</div>
      <p className="pane-sub">
        Every mockup, video ad and image ad made here, kept until you delete it, on any device. Star the keepers; reopen a video
        or image ad to keep editing it.
      </p>
      {error && <div className="flag" style={{ marginBottom: 14 }}><span className="ico">&#9873;</span><span>{error}</span></div>}

      <div className="card insp-filters">
        <div className="field-row">
          <label className="field">
            <span>Store</span>
            <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">All stores</option>
              {brandsSeen.map((b) => <option key={b} value={b}>{(BRANDS[b] || {}).name || b}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Kind</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Everything</option>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}s</option>)}
            </select>
          </label>
          <label className="field">
            <span>Show</span>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Favourites and drafts</option>
              <option value="favorite">Favourites</option>
              <option value="draft">Drafts only</option>
            </select>
          </label>
        </div>
        <div className="reply-actions" style={{ marginTop: -6 }}>
          <span className="acc-count">{drafts ? shown.length + ' of ' + drafts.length : 'loading...'}</span>
          <button className="btn btn-ghost" onClick={load}>Reload</button>
        </div>
      </div>

      {drafts && shown.length === 0 && (
        <div className="ledger-note mk-empty">Nothing here yet. Mockups land here as they are generated; video and image ads when you save or render them.</div>
      )}

      <div className="dr-grid">
        {shown.slice(0, limit).map((d) => (
          <div key={d.id} className="card dr-card">
            <Preview d={d} />
            <div className="insp-ad-top">
              <span className="insp-comp">{(BRANDS[d.brand] || {}).name || d.brand} · {KIND_LABELS[d.kind]}</span>
              <button type="button" className={'insp-star-btn' + (d.status === 'favorite' ? ' on' : '')} onClick={() => toggleFav(d)}
                title={d.status === 'favorite' ? 'Unfavourite' : 'Favourite'}>{d.status === 'favorite' ? '★' : '☆'}</button>
            </div>
            <div className="insp-headline">{d.title || KIND_LABELS[d.kind]}</div>
            {d.kind === 'mockup' && d.source && d.source.scene && <div className="insp-text dr-scene">{d.source.scene}</div>}
            <div className="insp-meta">{when(d.updatedAt)}{d.by ? ' · ' + d.by.split('@')[0] : ''}</div>
            <div className="reply-actions insp-actions">
              {d.kind !== 'mockup' && <button className="btn btn-primary" type="button" onClick={() => open(d)}>Open in builder</button>}
              {d.output && <a className="btn btn-ghost" href={d.output.url} target="_blank" rel="noreferrer" download>Download</a>}
              <button className="btn btn-ghost" type="button" onClick={() => remove(d)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {shown.length > limit && (
        <div className="reply-actions" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={() => setLimit((n) => n + PAGE)}>Show more</button>
        </div>
      )}
    </div>
  );
}
