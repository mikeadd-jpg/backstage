'use client';
// Orders likely to become a problem, from the risk scan (lib/risk.js). A dense table on
// desktop, compact cards on phones; search, severity and brand narrow it. Data and the
// Clear write stay in app/page.jsx, which also feeds the nav badge.
import { useMemo, useState } from 'react';
import { BRANDS, RAIL_BRANDS, matches } from './ui';

const SEV_ORDER = { high: 0, medium: 1 };

export default function AtRisk({ risk, loaded, onClear }) {
  const [sev, setSev] = useState('all');
  const [brand, setBrand] = useState('all');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => risk
    .filter((r) => (sev === 'all' || r.severity === sev) && (brand === 'all' || r.brand === brand) &&
      matches(query, r.order, r.customer, r.items, r.reasons.join(' ')))
    // Most urgent first, then oldest: the order a person should work them in.
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 2) - (SEV_ORDER[b.severity] ?? 2) || (b.age || 0) - (a.age || 0)),
  [risk, sev, brand, query]);

  const n = (s) => risk.filter((r) => s === 'all' || r.severity === s).length;

  return (
    <div className="risk-wrap">
      <div className="ord-tools">
        <input className="input ord-search" type="search" placeholder="Search order, customer, item, reason" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Search at-risk orders" />
        <div className="ibx-views" role="tablist" aria-label="Severity">
          {[['all', 'All'], ['high', 'High'], ['medium', 'Medium']].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={sev === k} className={'ibx-view' + (sev === k ? ' on' : '')} onClick={() => setSev(k)}>
              {label}<span className={'ibx-n' + (k === 'high' && n('high') ? ' warn' : '')}>{n(k)}</span>
            </button>
          ))}
        </div>
        <div className="ibx-brands" role="group" aria-label="Brand">
          <button className={'ibx-brand' + (brand === 'all' ? ' on' : '')} onClick={() => setBrand('all')}>All</button>
          {RAIL_BRANDS.map((b) => (
            <button key={b} className={'ibx-brand' + (brand === b ? ' on' : '')} onClick={() => setBrand(brand === b ? 'all' : b)}>
              <i style={{ background: BRANDS[b].color }} />{BRANDS[b].name}
            </button>
          ))}
        </div>
      </div>

      {loaded && risk.length === 0 && <div className="risk-empty">Nothing at risk right now. The scan checks recent orders every four hours.</div>}
      {loaded && risk.length > 0 && shown.length === 0 && <div className="risk-empty">Nothing matches these filters.</div>}

      {shown.length > 0 && (
        <div className="ord-table" role="table" aria-label="At-risk orders">
          <div className="ord-row ord-headrow" role="row">
            <span role="columnheader">Order</span>
            <span role="columnheader">Customer</span>
            <span role="columnheader">Items</span>
            <span role="columnheader">Why</span>
            <span role="columnheader" className="ord-r">Age</span>
            <span role="columnheader" className="ord-r">Actions</span>
          </div>
          {shown.map((r) => {
            const b = BRANDS[r.brand];
            return (
              <div key={r.id} className={'ord-row sev-' + r.severity} role="row">
                <span className="ord-order" role="cell">
                  <i className="ord-sev" title={r.severity === 'high' ? 'High' : 'Medium'} />
                  <b>{r.order}</b>
                  <span className="ord-brand" style={{ color: b.color }}>{b.name}</span>
                </span>
                <span className="ord-cust" role="cell">{r.customer}</span>
                <span className="ord-items" role="cell" title={r.items}>{r.items || '—'}</span>
                <span className="ord-why" role="cell">
                  {r.reasons.map((reason, i) => <span className="reason-pill" key={i}>{reason}</span>)}
                </span>
                <span className="ord-age ord-r" role="cell">{r.age}d</span>
                <span className="ord-acts ord-r" role="cell">
                  {r.url && r.url !== '#' && <a className="link-btn" href={r.url} target="_blank" rel="noreferrer">Open <span className="arw">&#8599;</span></a>}
                  <button className="btn btn-ghost" onClick={() => onClear(r)}>Clear</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
