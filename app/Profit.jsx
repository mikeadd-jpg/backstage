'use client';
// Profitability, read from the Profit Combined sheet. The server decides who sees this
// (the profit area in lib/roles.js, enforced by app/api/profit); hiding the tab is cosmetic.
// Numbers are the sheet's, so a mismatch is a sheet question, not a Backstage one.
//
// Filters, data and formatting are shared with the Attribution tab (app/insights.jsx);
// this file owns the profit tiles, cost breakdown, daily chart and brand table.
import { useEffect, useRef, useState } from 'react';
import { COST_LINES } from '../lib/profitMath';
import { useInsights, InsightsHeader, BRAND_COLOR, usd, pct, mult, delta, Delta } from './insights';

const METRICS = [
  { key: 'net', label: 'Net revenue', fmt: (v) => usd(v), good: 'up' },
  { key: 'costs', label: 'Total costs', fmt: (v) => usd(v), good: 'down', expands: true },
  { key: 'profit', label: 'Profit', fmt: (v) => usd(v), good: 'up', hero: true },
  { key: 'margin', label: 'Margin', fmt: pct, good: 'up' },
  { key: 'mer', label: 'MER (rev / Meta + Google)', fmt: mult, good: 'up' },
  { key: 'perOrder', label: 'Profit / order', fmt: (v) => usd(v, 2), good: 'up' },
  { key: 'orders', label: 'Orders', fmt: (v) => (v == null ? '—' : Math.round(v).toLocaleString()), good: 'up' },
  // Spend is neither good nor bad on its own, so its delta stays grey.
  { key: 'ads', label: 'Ad spend', fmt: (v) => usd(v), good: 'neutral',
    sub: (c) => 'Meta ' + usd(c.meta) + ' · Google ' + usd(c.google) },
];

/** Every cost line, grouped, with share of revenue, change vs prior and per-brand split. */
function CostBreakdown({ cur, prior, brands, className = '' }) {
  const lines = COST_LINES.filter((l) => Math.abs(cur[l.key]) >= 0.005 || (prior && Math.abs(prior[l.key]) >= 0.005));
  const groups = [...new Set(lines.map((l) => l.group))];
  const max = Math.max(1, ...lines.map((l) => Math.abs(cur[l.key])));
  return (
    <div className={'pf-costs ' + className} role="region" aria-label="Cost breakdown">
      {lines.length === 0 && <div className="pf-costs-empty">No costs in this period.</div>}
      {groups.map((g) => (
        <div key={g} className="pf-cost-group">
          <div className="pf-cost-group-label">{g}</div>
          {lines.filter((l) => l.group === g).map((l) => (
            <div key={l.key} className="pf-cost-line">
              <div className="pf-cost-top">
                <span className="pf-cost-name">{l.label}</span>
                <span className="pf-cost-amt">{usd(cur[l.key], 2)}</span>
              </div>
              <div className="pf-cost-bar"><span style={{ width: (Math.abs(cur[l.key]) / max) * 100 + '%' }} /></div>
              <div className="pf-cost-meta">
                <span>{cur.net ? pct(cur[l.key] / cur.net) + ' of revenue' : '—'}</span>
                {prior && <Delta d={delta(cur[l.key], prior[l.key])} good="down" />}
              </div>
              {brands.length > 1 && (
                <div className="pf-cost-split">
                  {brands.filter((b) => Math.abs(cur.byBrand[b][l.key]) >= 0.005).map((b) => (
                    <span key={b}><i style={{ background: BRAND_COLOR[b] || 'var(--muted)' }} />{b} {usd(cur.byBrand[b][l.key], 2)}</span>
                  ))}
                </div>
              )}
              {l.key === 'other' && (
                <div className="pf-cost-note">Net revenue minus profit, less every itemised line. Usually older rows whose profit was entered by hand.</div>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="pf-cost-total"><span>Total costs</span><span>{usd(cur.costs, 2)}</span></div>
    </div>
  );
}

/** One row per selected brand, best profit first. Clicking a row narrows to that brand. */
function BrandTable({ cur, prior, brands, onOnly }) {
  const rows = brands.map((b) => ({ b, c: cur.byBrand[b], p: prior ? prior.byBrand[b] : null }))
    .sort((x, y) => y.c.profit - x.c.profit);
  return (
    <div className="pf-brands">
      <div className="pf-label pf-brands-head">By brand</div>
      <div className="pf-table-wrap flush">
        <table className="pf-table pf-brand-table">
          <thead><tr><th>Brand</th><th>Revenue</th><th>Profit</th><th>Margin</th><th>Ad spend</th><th>MER</th><th>Orders</th></tr></thead>
          <tbody>
            {rows.map(({ b, c, p }) => (
              <tr key={b} onClick={() => onOnly(b)} title={'Show only ' + b} tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onOnly(b); }}>
                <td><i className="pf-dot" style={{ background: BRAND_COLOR[b] || 'var(--muted)' }} />{b}</td>
                <td>{usd(c.net)}</td>
                <td className={c.profit < 0 ? 'neg' : ''}>{usd(c.profit)} {p && <Delta d={delta(c.profit, p.profit)} good="up" />}</td>
                <td>{pct(c.margin)}</td>
                <td>{usd(c.ads)}</td>
                <td>{mult(c.mer)}</td>
                <td>{Math.round(c.orders).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProfitChart({ days }) {
  const [hover, setHover] = useState(null);
  // Drawn at the width it actually has, not a fixed 760 scaled down: on a phone that
  // shrank the chart to under 100px tall with unreadable axis labels.
  const box = useRef(null);
  const [W, setW] = useState(760);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 500 ? 200 : W > 700 ? 280 : 220, padL = 52, padR = 8, padT = 12, padB = 26;
  const max = Math.max(1, ...days.map((d) => d.profit));
  const min = Math.min(0, ...days.map((d) => d.profit));
  const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);
  const slot = (W - padL - padR) / Math.max(1, days.length);
  const gap = slot > 6 ? 2 : 0;           // 2px surface gap between bars while there is room for one
  const barW = Math.max(1, slot - gap);
  const zero = y(0);
  const ticks = [max, (max + min) / 2, min].filter((v, i, a) => a.indexOf(v) === i);
  const labelEvery = Math.ceil(days.length / (W < 500 ? 4 : 6));

  // Rounded at the data end only, square on the zero baseline.
  function barPath(x, v) {
    const top = Math.min(y(v), zero), bot = Math.max(y(v), zero), h = bot - top;
    const r = Math.min(4, barW / 2, h);
    if (h < 0.5) return `M${x},${zero}h${barW}`;
    return v >= 0
      ? `M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${bot}Z`
      : `M${x},${top}V${bot - r}Q${x},${bot} ${x + r},${bot}H${x + barW - r}Q${x + barW},${bot} ${x + barW},${bot - r}V${top}Z`;
  }

  const h = hover != null ? days[hover] : null;
  return (
    <div className="pf-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily profit">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="pf-grid" />
            <text x={padL - 8} y={y(t) + 4} className="pf-axis" textAnchor="end">{usd(t)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={zero} y2={zero} className="pf-zero" />
        {days.map((d, i) => {
          const x = padL + i * slot + gap / 2;
          return (
            <g key={d.date}>
              <path d={barPath(x, d.profit)} className={(d.profit >= 0 ? 'pf-pos' : 'pf-neg') + (hover === i ? ' on' : '')} />
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent"
                tabIndex={0} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onTouchStart={() => setHover(i)}
                aria-label={d.date + ' profit ' + usd(d.profit, 2)} />
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 8} className="pf-axis" textAnchor="middle">{d.date.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pf-tip" style={{ left: `${Math.min(85, Math.max(15, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <strong>{usd(h.profit, 2)}</strong>
          <span>{h.date} · profit</span>
          <span>{usd(h.net, 2)} net · {h.orders} orders</span>
          <span>{usd(h.meta, 2)} Meta · {usd(h.google, 2)} Google</span>
        </div>
      )}
    </div>
  );
}

export default function Profit() {
  const ins = useInsights();
  const { data, selected, setSelected, period, view } = ins;
  const [showCosts, setShowCosts] = useState(false);
  const [showTable, setShowTable] = useState(false);

  return (
    <div className="pane pf-pane">
      <InsightsHeader ins={ins} title="Profit" sub="From the Profit Combined sheet. Today is in progress until the morning run writes finals." />

      {data && selected && period && view && (
        <>
          <div className="pf-tiles">
            {METRICS.map((m) => {
              const body = (
                <>
                  <div className="pf-label">
                    {m.label}
                    {m.expands && <span className={'pf-chev' + (showCosts ? ' open' : '')} aria-hidden="true">{'›'}</span>}
                  </div>
                  <div className={'pf-value' + (m.key === 'profit' && view.cur.profit < 0 ? ' neg' : '')}>{m.fmt(view.cur[m.key])}</div>
                  {view.prior && <Delta d={delta(view.cur[m.key], view.prior[m.key])} good={m.good} />}
                  {m.sub && <div className="pf-sub">{m.sub(view.cur)}</div>}
                  {m.expands && <div className="pf-sub pf-tile-hint">{showCosts ? 'Hide breakdown' : 'Tap for breakdown'}</div>}
                </>
              );
              return m.expands ? (
                [
                  <button key={m.key} className={'pf-tile pf-tile-btn' + (showCosts ? ' open' : '')}
                    aria-expanded={showCosts} onClick={() => setShowCosts((s) => !s)}>{body}</button>,
                  // Phones only: on desktop the same breakdown sits permanently in the side column.
                  showCosts && <CostBreakdown key="costs" className="pf-costs-inline" cur={view.cur} prior={view.prior} brands={selected} />,
                ]
              ) : (
                <div key={m.key} className={'pf-tile' + (m.hero ? ' hero' : '')}>{body}</div>
              );
            })}
          </div>

          <div className="pf-body">
            <div className="pf-main">
              <div className="pf-chart-head">
                <div className="pf-label">Daily profit</div>
                <button className={'pf-chip small' + (showTable ? ' on' : '')} aria-pressed={showTable}
                  onClick={() => setShowTable((s) => !s)}>Table</button>
              </div>
              {view.days.length > 0
                ? <ProfitChart days={view.days} />
                : <div className="risk-empty">No rows for these brands in this period.</div>}

              {selected.length > 1 && (
                <BrandTable cur={view.cur} prior={view.prior} brands={selected} onOnly={(b) => setSelected([b])} />
              )}
              {showTable && view.days.length > 0 && (
                <div className="pf-table-wrap">
                  <table className="pf-table">
                    <thead><tr><th>Date</th><th>Net</th><th>Orders</th><th>Printify</th><th>Printful</th><th>Gelato</th><th>Meta</th><th>Google</th><th>Fees</th><th>Other</th><th>Profit</th></tr></thead>
                    <tbody>
                      {[...view.days].reverse().map((d) => (
                        <tr key={d.date}>
                          <td>{d.date}</td><td>{usd(d.net, 2)}</td><td>{d.orders}</td><td>{usd(d.printify, 2)}</td>
                          <td>{usd(d.printful, 2)}</td><td>{usd(d.gelato, 2)}</td><td>{usd(d.meta, 2)}</td>
                          <td>{usd(d.google, 2)}</td><td>{usd(d.fees, 2)}</td><td>{usd(d.other, 2)}</td>
                          <td className={d.profit < 0 ? 'neg' : ''}>{usd(d.profit, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <aside className="pf-side" aria-label="Where the money went">
              <div className="pf-label pf-side-head">Where the {usd(view.cur.costs)} went</div>
              <CostBreakdown cur={view.cur} prior={view.prior} brands={selected} />
            </aside>
          </div>
    </>
  )}
</div>
  );
}
