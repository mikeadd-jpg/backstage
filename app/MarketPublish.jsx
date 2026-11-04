'use client';
// "Add new products to their markets" in the Products tab (lib/marketPublish.js). A built
// product reaches no Elder Emo market until it is in the catalogs its tags name; this lists
// the products since 2026-10-16 that are not, and adds the ticked ones on a click.
import { useState } from 'react';
import { BRANDS } from './ui';

const STORES = ['elderemo', 'poppunks', 'wallspoke'];

export default function MarketPublish() {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState('elderemo');
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  async function check(b = brand) {
    setBusy('Checking the catalogs...'); setErr(''); setDone(null); setData(null);
    try {
      const res = await fetch('/api/markets?brand=' + encodeURIComponent(b), { cache: 'no-store' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not check.');
      setData(d); setPicked(Object.fromEntries(d.missing.map((p) => [p.id, true])));
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function publish() {
    const ids = Object.keys(picked).filter((k) => picked[k]);
    if (!ids.length) return;
    if (!window.confirm('Add ' + ids.length + ' product' + (ids.length === 1 ? '' : 's') + ' to their market catalogs? Shoppers in those markets will see them.')) return;
    setBusy('Publishing...'); setErr('');
    try {
      const res = await fetch('/api/markets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand, productIds: ids }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not publish.');
      setDone(d); await check();
    } catch (e) { setErr(e.message); setBusy(''); }
  }

  if (!open) {
    return (
      <div className="reply-actions" style={{ marginBottom: 12 }}>
        <button className="btn btn-ghost" type="button" onClick={() => { setOpen(true); check(); }}>Add new products to their markets</button>
      </div>
    );
  }
  const n = Object.values(picked).filter(Boolean).length;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-label">New products into their market catalogs</div>
      <p className="pane-sub" style={{ marginTop: 0 }}>
        Products made since {data ? data.since : '2026-10-16'} that are tagged for a market (us, ca, uk, au) but not yet in that market's
        catalog. Only adds; older products are left alone, since the Canada and Australia catalogs were pruned on purpose.
      </p>
      <div className="field-row">
        <label className="field"><span>Store</span>
          <select className="input" value={brand} onChange={(e) => { setBrand(e.target.value); check(e.target.value); }}>
            {STORES.map((b) => <option key={b} value={b}>{(BRANDS[b] || {}).name || b}</option>)}
          </select>
        </label>
      </div>
      {busy && <div className="ledger-note">{busy}</div>}
      {err && <div className="login-error">{err}</div>}
      {done && <div className="ledger-note">Published {done.published.length}{done.failed.length ? ', ' + done.failed.length + ' failed: ' + done.failed.map((f) => f.title + ' (' + f.error + ')').join('; ') : ''}.</div>}
      {data && !data.catalogs.length && <div className="ledger-note">This store has no market catalogs: every product is sold in every market it sells to.</div>}
      {data && data.catalogs.length > 0 && data.missing.length === 0 && <div className="ledger-note">All caught up: {data.checked} recent products checked.</div>}
      {data && data.missing.length > 0 && (
        <>
          <div className="mp-list">
            {data.missing.map((p) => (
              <label key={p.id} className="check mp-row">
                <input type="checkbox" checked={Boolean(picked[p.id])} onChange={(e) => setPicked((x) => ({ ...x, [p.id]: e.target.checked }))} />
                <span className="mp-title">{p.title}</span>
                <span className="mp-markets">{p.markets.map((m) => m.toUpperCase()).join(' ')}</span>
              </label>
            ))}
          </div>
          <div className="reply-actions" style={{ marginTop: 8 }}>
            <button className="btn btn-primary" type="button" disabled={Boolean(busy) || !n} onClick={publish}>Add {n} to their markets</button>
            <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}
