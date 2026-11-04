'use client';
// Every mockup, video ad and image ad the creative tools have made, kept until deleted
// (lib/drafts.js), so nothing is lost when a tab closes and the same work shows on any
// device. Favourite the keepers, delete the rest, download a file, or reopen a video or
// image draft in its builder in the Ads tab to keep editing it. Video and image ads can be
// rendered on the server from here (lib/serverRender.js), which is the way to make one from
// a phone: it carries on with the page closed, and the file shows here when it lands.
import { useEffect, useMemo, useRef, useState } from 'react';
import { OPEN_DRAFT_KEY, renderJob, renderFailed, renderStatusText, startServerRender, pollRenders } from './draftsClient.js';
import { BRANDS } from './ui';
import { ACCENTS } from '../lib/adPlans.js';
import Batches from './Batches.jsx';

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
  const job = renderJob(o);
  if (o && o.url && !job && /^video\//.test(o.contentType || '')) return <video className="dr-media" src={o.url} controls playsInline preload="metadata" />;
  if (o && o.url && !job) return <img className="dr-media" src={o.url} alt="" loading="lazy" />;
  // Not rendered yet, or rendering: the first picture it uses stands in.
  const pic = (d.assets || []).find((a) => a.kind === 'image');
  return (
    <div className="dr-media dr-unrendered">
      {pic && <img src={pic.url} alt="" loading="lazy" />}
      <span>{job ? renderStatusText(job) : 'Not rendered yet'}</span>
      {job && <div className="dr-progress"><div style={{ width: Math.round((job.progress || 0) * 100) + '%' }} /></div>}
    </div>
  );
}

// How an ad sent to Meta is doing, read back daily (lib/adResults.js).
function MetaLine({ meta }) {
  const r = meta.results;
  if (!r) return <div className="dr-meta">In Meta{meta.adId ? ' as a paused ad' : ' as a creative'}; results show the day after it runs.</div>;
  if (!r.ads) return <div className="dr-meta">In Meta, not in any ad yet.</div>;
  if (!r.spend) return <div className="dr-meta">In {r.ads} ad{r.ads === 1 ? '' : 's'}{r.active ? ', running' : ', not running'}; nothing spent yet.</div>;
  return (
    <div className="dr-meta">
      Meta: <strong>${r.spend.toFixed(2)}</strong> spent · {r.purchases} purchase{r.purchases === 1 ? '' : 's'} · ROAS <strong>{r.roas == null ? 'n/a' : r.roas}</strong> · CTR {r.ctr}%
      {r.active ? ' · running' : ''}
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

  // While any draft is rendering on the server, ask how it is going every few seconds.
  const rendering = useMemo(() => (drafts || []).filter((d) => renderJob(d.output)).map((d) => d.id), [drafts]);
  const busy = useRef(false);
  useEffect(() => {
    if (!rendering.length) return undefined;
    const t = setInterval(async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const outs = await pollRenders(rendering);
        setDrafts((xs) => xs.map((x) => (outs[x.id] && !outs[x.id].error ? { ...x, output: outs[x.id] } : x)));
      } catch { /* try again on the next tick */ } finally { busy.current = false; }
    }, 4000);
    return () => clearInterval(t);
  }, [rendering.join(',')]);

  async function render(d) {
    setError('');
    try {
      const job = await startServerRender(d.id, ACCENTS[d.brand]);
      setDrafts((xs) => xs.map((x) => (x.id === d.id ? { ...x, output: { ...(x.output || {}), job } } : x)));
    } catch (e) { setError(e.message); }
  }

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
        Every mockup, video ad and image ad made here, on any device. Star the keepers: plain drafts nobody touches for 60 days
        are cleared out, but never favourites or anything sent to Meta. Reopen a video or image ad to keep editing it.
      </p>
      {error && <div className="flag" style={{ marginBottom: 14 }}><span className="ico">&#9873;</span><span>{error}</span></div>}
      <Batches onSettled={load} />

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
            {d.kind === 'mockup' && d.source && d.source.check && (
              d.source.check.pass
                ? <div className="dr-check ok" title={'Print check ' + d.source.check.score + '/10'}>✓ Print checked</div>
                : <div className="dr-check bad">Print may be off ({d.source.check.score}/10){d.source.check.problems.length ? ': ' + d.source.check.problems.join('; ') : ''}</div>
            )}
            {d.kind === 'mockup' && d.source && d.source.scene && <div className="insp-text dr-scene">{d.source.scene}</div>}
            {d.kind !== 'mockup' && d.source && d.source.meta && <MetaLine meta={d.source.meta} />}
            <div className="insp-meta">{when(d.updatedAt)}{d.by ? ' · ' + d.by.split('@')[0] : ''}</div>
            {renderFailed(d.output) && <div className="dr-failed">Render failed: {renderFailed(d.output)}</div>}
            <div className="reply-actions insp-actions">
              {d.kind !== 'mockup' && <button className="btn btn-primary" type="button" onClick={() => open(d)}>Open in builder</button>}
              {d.kind !== 'mockup' && !renderJob(d.output) && (
                <button className="btn btn-ghost" type="button" onClick={() => render(d)}
                  title="Renders on the server: you can close the page and come back.">{d.output && d.output.url ? 'Render again' : 'Render'}</button>
              )}
              {d.output && d.output.url && <a className="btn btn-ghost" href={d.output.url} target="_blank" rel="noreferrer" download>Download</a>}
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
