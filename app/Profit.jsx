'use client';
// Profitability, read from the Profit Combined sheet. The server decides who sees this
// (lib/profit.js canViewProfit); the tab only appears for those people, which is cosmetic.
// Numbers are the sheet's, so a mismatch is a sheet question, not a Backstage one.
import { useEffect, useMemo, useState } from 'react';

const usd = (n, digits = 0) => {
  if (n == null || isNaN(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (n < 0 ? '-$' : '$') + s;
};
const pct = (n) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%');
const mult = (n) => (n == null || isNaN(n) ? '—' : n.toFixed(2) + 'x');

// Change vs prior, on the absolute base so a swing through zero still reads sensibly.
function delta(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

const METRICS = [
  { key: 'net', label: 'Net revenue', fmt: (v) => usd(v), good: 'up' },
  { key: 'costs', label: 'Total costs', fmt: (v) => usd(v), good: 'down' },
  { key: 'profit', label: 'Profit', fmt: (v) => usd(v), good: 'up', hero: true },
  { key: 'margin', label: 'Margin', fmt: pct, good: 'up' },
  { key: 'mer', label: 'MER (rev / Meta + Google)', fmt: mult, good: 'up' },
  { key: 'perOrder', label: 'Profit / order', fmt: (v) => usd(v, 2), good: 'up' },
  { key: 'orders', label: 'Orders', fmt: (v) => (v == null ? '—' : Math.round(v).toLocaleString()), good: 'up' },
  // Spend is neither good nor bad on its own, so its delta stays grey.
  { key: 'ads', label: 'Ad spend', fmt: (v) => usd(v), good: 'neutral',
    sub: (c) => 'Meta ' + usd(c.meta) + ' · Google ' + usd(c.google) },
];

function Delta({ d, good }) {
  if (d == null) return <span className="pf-delta muted">—</span>;
  const up = d > 0;
  const tone = good === 'neutral' || Math.abs(d) < 0.05 ? 'muted' : (up === (good === 'up') ? 'good' : 'bad');
  return (
    <span className={'pf-delta ' + tone}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : ''}{(d * 100).toFixed(1)}%
    </span>
  );
}

function ProfitChart({ days }) {
  const [hover, setHover] = useState(null);
  const W = 760, H = 220, padL = 52, padR = 8, padT = 12, padB = 26;
  const max = Math.max(1, ...days.map((d) => d.profit));
  const min = Math.min(0, ...days.map((d) => d.profit));
  const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);
  const slot = (W - padL - padR) / Math.max(1, days.length);
  const barW = Math.max(2, slot - 2); // 2px surface gap between bars
  const zero = y(0);
  const ticks = [max, (max + min) / 2, min].filter((v, i, a) => a.indexOf(v) === i);
  const labelEvery = Math.ceil(days.length / 6);

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
    <div className="pf-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily profit">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="pf-grid" />
            <text x={padL - 8} y={y(t) + 4} className="pf-axis" textAnchor="end">{usd(t)}</text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={zero} y2={zero} className="pf-zero" />
        {days.map((d, i) => {
          const x = padL + i * slot + 1;
          return (
            <g key={d.date}>
              <path d={barPath(x, d.profit)} className={(d.profit >= 0 ? 'pf-pos' : 'pf-neg') + (hover === i ? ' on' : '')} />
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent"
                tabIndex={0} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                aria-label={d.date + ' profit ' + usd(d.profit, 2)} />
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 8} className="pf-axis" textAnchor="middle">{d.date.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pf-tip" style={{ left: `${((padL + hover * slot + slot / 2) / W) * 100}%` }}>
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
  const [brand, setBrand] = useState('all');
  const [periodKey, setPeriodKey] = useState('7d');
  const [range, setRange] = useState(30);
  const [showTable, setShowTable] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true); setError('');
    fetch('/api/profit?brand=' + encodeURIComponent(brand))
      .then((r) => r.json())
      .then((d) => { if (d.error) throw new Error(d.error); setData(d); })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [brand]);

  const period = data ? data.periods.find((p) => p.key === periodKey) : null;
  const days = useMemo(() => (data ? data.daily.slice(-range) : []), [data, range]);

  return (
    <div className="pane pf-pane">
      <div className="pane-head">Profit</div>
      <div className="pane-sub">
        From the Profit Combined sheet{data && data.lastDate ? ', latest row ' + data.lastDate : ''}.
        Today is in progress until the morning run writes finals.
      </div>

      <div className="pf-filters">
        <div className="pf-seg" role="group" aria-label="Brand">
          {['all', ...(data ? data.brands : [])].map((b) => (
            <button key={b} className={brand === b ? 'on' : ''} onClick={() => setBrand(b)}>{b === 'all' ? 'All brands' : b}</button>
          ))}
        </div>
        <div className="pf-seg" role="group" aria-label="Period">
          {(data ? data.periods : []).map((p) => (
            <button key={p.key} className={periodKey === p.key ? 'on' : ''} onClick={() => setPeriodKey(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      {error && <div className="approve-error">{error}</div>}
      {loading && !data && <div className="risk-empty">Loading…</div>}

      {period && (
        <>
          <div className="pf-period">{period.label} · {period.from === period.to ? period.from : period.from + ' to ' + period.to} · <span className="pf-cmp">{period.compareLabel}</span></div>
          <div className="pf-tiles">
            {METRICS.map((m) => (
              <div key={m.key} className={'pf-tile' + (m.hero ? ' hero' : '')}>
                <div className="pf-label">{m.label}</div>
                <div className={'pf-value' + (m.key === 'profit' && period.current.profit < 0 ? ' neg' : '')}>{m.fmt(period.current[m.key])}</div>
                {period.prior && <Delta d={delta(period.current[m.key], period.prior[m.key])} good={m.good} />}
                {m.sub && <div className="pf-sub">{m.sub(period.current)}</div>}
              </div>
            ))}
          </div>

          <div className="pf-chart-head">
            <div className="pf-label">Daily profit</div>
            <div className="pf-seg small">
              {[30, 90].map((n) => <button key={n} className={range === n ? 'on' : ''} onClick={() => setRange(n)}>{n} days</button>)}
              <button className={showTable ? 'on' : ''} onClick={() => setShowTable((s) => !s)}>Table</button>
            </div>
          </div>
          {days.length > 0 && <ProfitChart days={days} />}

          {showTable && (
            <div className="pf-table-wrap">
              <table className="pf-table">
                <thead><tr><th>Date</th><th>Net</th><th>Orders</th><th>Printify</th><th>Printful</th><th>Meta</th><th>Google</th><th>Fees</th><th>Profit</th></tr></thead>
                <tbody>
                  {[...days].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td><td>{usd(d.net, 2)}</td><td>{d.orders}</td><td>{usd(d.printify, 2)}</td>
                      <td>{usd(d.printful, 2)}</td><td>{usd(d.meta, 2)}</td><td>{usd(d.google, 2)}</td><td>{usd(d.fees, 2)}</td>
                      <td className={d.profit < 0 ? 'neg' : ''}>{usd(d.profit, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
