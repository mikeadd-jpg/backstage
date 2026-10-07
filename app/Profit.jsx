'use client';
// Profitability, read from the Profit Combined sheet. The server decides who sees this
// (the profit area in lib/roles.js, enforced by app/api/profit); hiding the tab is cosmetic.
// Numbers are the sheet's, so a mismatch is a sheet question, not a Backstage one.
//
// The page fetches the daily rows once and does all the slicing here with
// lib/profitMath.js, so brand toggles and date changes are instant on a phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COST_LINES, CHANNELS, totals, dailySeries, presetPeriods, customPeriod, firstDates, addDays,
  channelStats, channelStart,
} from '../lib/profitMath';

const BRAND_COLOR = { 'Elder Emo': 'var(--violet)', PopPunks: 'var(--pink)', Wallspoke: 'var(--blue)' };
const PREF_KEY = 'backstage.profit.view';

const usd = (n, digits = 0) => {
  if (n == null || isNaN(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (n < 0 ? '-$' : '$') + s;
};
const pct = (n) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(1) + '%');
const mult = (n) => (n == null || isNaN(n) ? '—' : n.toFixed(2) + 'x');
const shortDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Change vs prior, on the absolute base so a swing through zero still reads sensibly.
function delta(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

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

const ratio = (n) => (n == null || isNaN(n) ? '—' : n.toFixed(2) + 'x');
const count = (n) => (n == null || isNaN(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString());

/**
 * Meta and Google, each judged twice: by the orders Shopify credits to them and by the
 * conversions they report themselves. The gap column is platform ÷ Shopify: above 1 the
 * platform claims more than Shopify gives it, below 1 its tracking is probably missing
 * purchases.
 */
function Channels({ cur, hasChannels, startsOn, periodFrom }) {
  if (!hasChannels) {
    return (
      <div className="pf-channels-empty">
        Channel columns aren't in the Profit Combined sheet yet. They appear once the updated sheet scripts are pasted in and run.
      </div>
    );
  }
  return (
    <>
      {startsOn && startsOn > periodFrom && (
        <div className="pf-note">
          Channel history starts {shortDate(startsOn)}, so earlier days in this range count as zero orders while
          their spend still counts. CPA reads high until backfillChannels has run in each brand sheet.
        </div>
      )}
      <div className="pf-channels">
        {CHANNELS.map((ch) => {
          const c = channelStats(cur, ch);
          const quiet = !c.spend && !c.shopify.orders && !c.platform.orders;
          const gapTone = (g) => (g == null ? '' : g < 0.8 ? ' under' : g > 1.25 ? ' over' : '');
          return (
            <div className="pf-ch" key={ch.key}>
              <div className="pf-ch-head">
                <span className="pf-ch-name">{ch.label}</span>
                <span className="pf-ch-spend">{usd(c.spend)} spend</span>
              </div>
              {quiet ? (
                <div className="pf-ch-quiet">No spend or orders in this period.</div>
              ) : (
                <table className="pf-ch-table">
                  <thead>
                    <tr><th /><th>Shopify</th><th>{ch.platform}</th><th title="Platform ÷ Shopify">Gap</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>Orders</td><td>{count(c.shopify.orders)}</td><td>{count(c.platform.orders)}</td>
                      <td className={'pf-gap' + gapTone(c.orderGap)}>{ratio(c.orderGap)}</td></tr>
                    <tr><td>Revenue</td><td>{usd(c.shopify.revenue)}</td><td>{usd(c.platform.revenue)}</td>
                      <td className={'pf-gap' + gapTone(c.revenueGap)}>{ratio(c.revenueGap)}</td></tr>
                    <tr><td>CPA</td><td>{usd(c.shopify.cpa, 2)}</td><td>{usd(c.platform.cpa, 2)}</td><td /></tr>
                    <tr><td>ROAS</td><td>{mult(c.shopify.roas)}</td><td>{mult(c.platform.roas)}</td><td /></tr>
                  </tbody>
                </table>
              )}
              <div className="pf-ch-foot">
                {ch.platform} on {ch.window}. Shopify credits the visit that placed the order
                {ch.key === 'google' ? '; organic search is excluded.' : '; Facebook and Instagram social clicks count too.'}
              </div>
            </div>
          );
        })}
      </div>
    </>
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

function loadPrefs() {
  try { return JSON.parse(window.localStorage.getItem(PREF_KEY) || 'null') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* per-device nicety only */ }
}

export default function Profit() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);   // brand names; null until data arrives
  const [periodKey, setPeriodKey] = useState('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [showCosts, setShowCosts] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    fetch('/api/profit')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        const prefs = loadPrefs();
        // Keep only remembered brands that still exist; fall back to all of them.
        const kept = (prefs.brands || []).filter((b) => d.brands.includes(b));
        setSelected(kept.length ? kept : d.brands);
        if (prefs.periodKey) setPeriodKey(prefs.periodKey);
        setCustom(prefs.custom && prefs.custom.from ? prefs.custom : { from: addDays(d.today, -13), to: d.today });
        setData(d);
      })
      .catch((e) => setError(String(e.message || e)));
  }, []);

  useEffect(() => {
    if (selected) savePrefs({ brands: selected, periodKey, custom });
  }, [selected, periodKey, custom]);

  const presets = useMemo(() => (data ? presetPeriods(data.today) : []), [data]);
  const customValid = custom.from && custom.to && custom.from <= custom.to;
  const period = periodKey === 'custom'
    ? (customValid ? customPeriod(custom.from, custom.to) : null)
    : presets.find((p) => p.key === periodKey) || presets[2];

  const view = useMemo(() => {
    if (!data || !selected || !period) return null;
    const cur = totals(data.rows, selected, period.from, period.to);
    const prior = period.compare ? totals(data.rows, selected, period.compare.from, period.compare.to) : null;
    const days = dailySeries(data.rows, selected, period.from, period.to);
    // A brand whose data starts after the comparison window begins makes the prior
    // period look smaller than it was, which inflates every delta. Say so.
    const starts = firstDates(data.rows);
    const partial = period.compare ? selected.filter((b) => starts[b] && starts[b] > period.compare.from) : [];
    return { cur, prior, days, partial, starts, channelsFrom: channelStart(data.rows.filter((r) => selected.includes(r.brand))) };
  }, [data, selected, period && period.from, period && period.to, period && period.compare && period.compare.from]);

  function toggleBrand(b) {
    setSelected((s) => {
      if (s.includes(b)) return s.length === 1 ? s : s.filter((x) => x !== b);  // never zero brands
      return data.brands.filter((x) => x === b || s.includes(x));                 // keep sheet order
    });
  }
  const allOn = data && selected && selected.length === data.brands.length;

  return (
    <div className="pane pf-pane">
      <div className="pane-head">Profit</div>
      <div className="pane-sub">
        From the Profit Combined sheet{data && data.lastDate ? ', latest row ' + data.lastDate : ''}.
        Today is in progress until the morning run writes finals.
      </div>

      {error && <div className="approve-error">{error}</div>}
      {!data && !error && <div className="risk-empty">Loading…</div>}

      {data && selected && (
        <>
          {/* One toolbar: stacked on phones, side by side on wider screens. */}
          <div className="pf-toolbar">
            <div className="pf-group">
              <div className="pf-filter-label">Brands</div>
              <div className="pf-chips" role="group" aria-label="Brands">
                <button className={'pf-chip' + (allOn ? ' on' : '')} aria-pressed={allOn}
                  onClick={() => setSelected(data.brands)}>All</button>
                {data.brands.map((b) => {
                  const on = selected.includes(b);
                  return (
                    <button key={b} className={'pf-chip' + (on ? ' on' : '')} aria-pressed={on} onClick={() => toggleBrand(b)}>
                      <i style={{ background: BRAND_COLOR[b] || 'var(--muted)' }} />{b}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="pf-group pf-group-period">
              <div className="pf-filter-label">Period</div>
              <div className="pf-chips scroll" role="group" aria-label="Period">
                {[...presets, { key: 'custom', label: 'Custom' }].map((p) => (
                  <button key={p.key} className={'pf-chip' + (periodKey === p.key ? ' on' : '')} aria-pressed={periodKey === p.key}
                    onClick={() => setPeriodKey(p.key)}>{p.label}</button>
                ))}
              </div>
            </div>
          </div>
          {periodKey === 'custom' && (
            <div className="pf-custom">
              <label>From
                <input type="date" value={custom.from} min={view && view.starts ? Object.values(view.starts).sort()[0] : undefined}
                  max={data.today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
              </label>
              <label>To
                <input type="date" value={custom.to} max={data.today}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
              </label>
              {!customValid && <div className="pf-custom-err">Pick a start date on or before the end date.</div>}
            </div>
          )}

          {period && view && (
            <>
              <div className="pf-period">
                {period.from === period.to ? shortDate(period.from) : shortDate(period.from) + ' – ' + shortDate(period.to)}
                {' · '}<span className="pf-cmp">{period.compareLabel}</span>
              </div>
              {view.partial.length > 0 && (
                <div className="pf-note">
                  {view.partial.map((b) => b + ' data starts ' + shortDate(view.starts[b])).join('; ')}, inside the
                  comparison window, so the % changes overstate growth.
                </div>
              )}

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

                  <div className="pf-label pf-section-head">Channels</div>
                  <Channels cur={view.cur} hasChannels={data.hasChannels} startsOn={view.channelsFrom} periodFrom={period.from} />
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
        </>
      )}
    </div>
  );
}
