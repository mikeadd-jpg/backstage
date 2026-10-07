'use client';
// Traffic and how good it is, from each brand's Shopify Analytics (lib/traffic.js): how
// many sessions, where they came from, how far down the funnel each source gets, what a
// session is worth, and which landing pages and devices leak. Owner-only through the
// traffic area (lib/roles.js). Shares the Insights filter bar (app/insights.jsx).
//
// Each period is one request (and the previous period a lighter second one); brand
// toggles re-sum on the device through lib/trafficMath.js.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bucketUnit, bucketKey, addDays } from '../lib/profitMath';
import { groupChannels, mergeRows, blank, add, rates } from '../lib/trafficMath';
import { useInsights, InsightsHeader, BRAND_COLOR, usd, pct, count, delta, Delta, shortDate } from './insights';

const TYPE_COLOR = { paid: '#2a78d6', organic: '#1baf7a', direct: '#4a3aa7', unknown: '#b0b0b0' };
const TYPE_LABEL = { paid: 'Paid', organic: 'Organic', direct: 'Direct', unknown: 'Unknown' };

function duration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
}
const dec = (n) => (n == null ? '—' : n.toFixed(2));

function useTraffic(from, to, lite) {
  const [state, setState] = useState({ loading: false, data: null, error: '' });
  useEffect(() => {
    if (!from || !to) { setState({ loading: false, data: null, error: '' }); return undefined; }
    let dead = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    fetch(`/api/traffic?from=${from}&to=${to}${lite ? '&lite=1' : ''}`).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (d.error) throw new Error(d.error);
      setState({ loading: false, data: d, error: '' });
    }).catch((e) => { if (!dead) setState({ loading: false, data: null, error: String(e.message || e) }); });
    return () => { dead = true; };
  }, [from, to, lite]);
  return state;
}

/** Totals, channel groups, landing pages and devices for the chosen brands. */
function summarise(report, selected) {
  if (!report) return null;
  const brands = report.brands.filter((b) => selected.includes(b.name) && !b.error);
  const by = (field) => Object.fromEntries(brands.map((b) => [b.name, b[field] || []]));
  const channels = mergeRows(by('channels'), brands.map((b) => b.name), (r) => r.channel + '|' + r.type);
  const groups = groupChannels(channels);
  // Totals count storefront sessions and the sales they produced; orders with no session
  // (the "none" group) are shown in the table but kept out of revenue per session.
  const total = groups.filter((g) => g.key !== 'none').reduce((t, g) => add(t, g), blank());
  total.visitors = brands.reduce((n, b) => n + (b.visitors || 0), 0);
  const landing = brands.flatMap((b) => (b.landing || []).map((r) => ({ ...r, brand: b.name })));
  const devices = mergeRows(by('devices'), brands.map((b) => b.name), (r) => r.device);
  const daily = brands.flatMap((b) => b.daily || []);
  return { total, groups, landing, devices, daily };
}

function Tiles({ cur, prior }) {
  const r = rates(cur), pr = prior ? rates(prior) : null;
  const tiles = [
    { label: 'Sessions', value: count(cur.sessions), d: prior && delta(cur.sessions, prior.sessions), good: 'up',
      sub: count(cur.visitors) + ' visitors', hero: true },
    { label: 'Conversion rate', value: pct(r.convRate), d: pr && delta(r.convRate, pr.convRate), good: 'up',
      sub: count(cur.completed) + ' sessions ordered' },
    { label: 'Revenue per session', value: usd(r.revPerSession, 2), d: pr && delta(r.revPerSession, pr.revPerSession), good: 'up',
      sub: 'AOV ' + usd(r.aov, 2) },
    { label: 'Bounce rate', value: pct(r.bounceRate), d: pr && delta(r.bounceRate, pr.bounceRate), good: 'down',
      sub: dec(r.pagesPerSession) + ' pages · ' + duration(r.avgSeconds) },
  ];
  return (
    <div className="pf-tiles">
      {tiles.map((t) => (
        <div className={'pf-tile' + (t.hero ? ' hero' : '')} key={t.label}>
          <div className="pf-label">{t.label}</div>
          <div className="pf-value">{t.value}</div>
          {prior && <Delta d={t.d} good={t.good} />}
          {t.sub && <div className="pf-sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Sessions -> cart -> checkout -> ordered, each as a share of sessions and of the step before. */
function Funnel({ t, prior }) {
  const steps = [
    { key: 'sessions', label: 'Sessions' },
    { key: 'cart', label: 'Added to cart' },
    { key: 'checkout', label: 'Reached checkout' },
    { key: 'completed', label: 'Ordered' },
  ];
  return (
    <div className="tr-funnel">
      {steps.map((s, i) => {
        const share = t.sessions ? t[s.key] / t.sessions : null;
        const step = i && t[steps[i - 1].key] ? t[s.key] / t[steps[i - 1].key] : null;
        const pShare = prior && prior.sessions ? prior[s.key] / prior.sessions : null;
        return (
          <div className="tr-step" key={s.key}>
            <div className="pf-label">{s.label}</div>
            <div className="tr-step-bar"><span style={{ width: Math.max(1.5, (share || 0) * 100) + '%' }} /></div>
            <div className="tr-step-nums">
              <b>{count(t[s.key])}</b>
              {i > 0 && <span>{pct(share)} of sessions</span>}
              {i > 0 && <span className="tr-step-of">{pct(step)} of the step before</span>}
              {i > 0 && prior && <Delta d={delta(share, pShare)} good="up" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function useWidth(initial = 760) {
  const box = useRef(null);
  const [W, setW] = useState(initial);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [box, W];
}

/** Sessions per day / week / month, stacked by paid, organic, direct and unknown. */
function SessionsChart({ daily, from, to }) {
  const unit = bucketUnit(from, to);
  const types = ['paid', 'organic', 'direct', 'unknown'];
  const buckets = useMemo(() => {
    const map = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const k = bucketKey(d, unit);
      if (!map.has(k)) map.set(k, { date: k, total: 0, completed: 0, paid: 0, organic: 0, direct: 0, unknown: 0 });
    }
    for (const r of daily) {
      const b = map.get(bucketKey(r.date, unit));
      if (!b) continue;
      const t = types.includes(r.type) ? r.type : 'unknown';
      b[t] += r.sessions;
      b.total += r.sessions;
      b.completed += r.completed;
    }
    return [...map.values()];
  }, [daily, from, to, unit]);  // types is constant
  const [hover, setHover] = useState(null);
  const [box, W] = useWidth();

  const H = W < 500 ? 210 : 250, padL = 48, padR = 8, padT = 10, padB = 26;
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const slot = (W - padL - padR) / buckets.length;
  const gap = slot > 6 ? 2 : 0;
  const barW = Math.max(1, slot - gap);
  const labelEvery = Math.ceil(buckets.length / (W < 500 ? 4 : 7));
  const fmtX = (iso) => (unit === 'month' ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : iso.slice(5));
  const h = hover != null ? buckets[hover] : null;

  return (
    <div className="pf-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'Sessions per ' + unit + ' by traffic type'}>
        {[max, max / 2, 0].map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t ? 'pf-grid' : 'pf-zero'} />
            <text x={padL - 8} y={y(t) + 4} className="pf-axis" textAnchor="end">{count(Math.round(t))}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * slot + gap / 2;
          let acc = 0;
          return (
            <g key={b.date}>
              {types.map((t) => {
                if (!b[t]) return null;
                const top = y(acc + b[t]), bot = y(acc);
                acc += b[t];
                return <rect key={t} x={x} y={top} width={barW} height={Math.max(0, bot - top)} fill={TYPE_COLOR[t]}
                  opacity={hover == null || hover === i ? 1 : 0.5} />;
              })}
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" tabIndex={0}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onTouchStart={() => setHover(i)}
                aria-label={b.date + ': ' + b.total + ' sessions'} />
              {i % labelEvery === 0 && <text x={x + barW / 2} y={H - 8} className="pf-axis" textAnchor="middle">{fmtX(b.date)}</text>}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pf-tip at-tip" style={{ left: `${Math.min(80, Math.max(20, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <strong>{count(h.total)} sessions</strong>
          <span>{unit === 'day' ? h.date : (unit === 'week' ? 'Week of ' + shortDate(h.date) : fmtX(h.date) + ' ' + h.date.slice(0, 4))}</span>
          {types.filter((t) => h[t]).map((t) => (
            <span key={t} className="at-tip-row"><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}<b>{count(h[t])}</b></span>
          ))}
          <span className="at-tip-row">Conversion<b>{pct(h.total ? h.completed / h.total : null)}</b></span>
        </div>
      )}
      <div className="at-chart-unit">
        {types.map((t) => <span key={t} className="em-key"><i style={{ background: TYPE_COLOR[t] }} />{TYPE_LABEL[t]}</span>)}
        Per {unit}
      </div>
    </div>
  );
}

const CH_COLS = [
  { key: 'sessions', label: 'Sessions', get: (t) => t.sessions, fmt: count },
  { key: 'share', label: 'Share', get: (t, r, tot) => (tot.sessions ? t.sessions / tot.sessions : null), fmt: pct },
  { key: 'cartRate', label: 'Cart', get: (t, r) => r.cartRate, fmt: pct },
  { key: 'checkoutRate', label: 'Checkout', get: (t, r) => r.checkoutRate, fmt: pct },
  { key: 'convRate', label: 'Conv.', get: (t, r) => r.convRate, fmt: pct, delta: true },
  { key: 'bounceRate', label: 'Bounce', get: (t, r) => r.bounceRate, fmt: pct },
  { key: 'pagesPerSession', label: 'Pages', get: (t, r) => r.pagesPerSession, fmt: dec },
  { key: 'avgSeconds', label: 'Time', get: (t, r) => r.avgSeconds, fmt: duration },
  { key: 'orders', label: 'Orders', get: (t) => t.orders, fmt: count },
  { key: 'sales', label: 'Revenue', get: (t) => t.sales, fmt: (v) => usd(v) },
  { key: 'revPerSession', label: 'Rev / session', get: (t, r) => r.revPerSession, fmt: (v) => usd(v, 2), delta: true },
];

function ChannelTable({ groups, prior, total }) {
  const [open, setOpen] = useState(() => new Set());
  const priorOf = useMemo(() => new Map((prior || []).map((g) => [g.key, g])), [prior]);
  const toggle = (k) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <div className="pf-table-wrap flush">
      <table className="pf-table em-flows tr-channels">
        <thead><tr><th>Channel</th>{CH_COLS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {groups.map((g) => {
            const r = rates(g), pg = priorOf.get(g.key), pr = pg ? rates(pg) : null;
            const subRows = [...g.rows].sort((a, b) => b.sessions - a.sessions || b.sales - a.sales);
            return (
              <Fragment key={g.key}>
                <tr className="em-flow" onClick={() => toggle(g.key)} tabIndex={0} aria-expanded={open.has(g.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(g.key); }}>
                  <td><span className={'pf-chev' + (open.has(g.key) ? ' open' : '')}>›</span>
                    <i className="pf-dot" style={{ background: g.color }} /><span className="em-name">{g.label}</span></td>
                  {CH_COLS.map((c) => (
                    <td key={c.key}>
                      {g.key === 'none' && !['orders', 'sales'].includes(c.key) ? '' : c.fmt(c.get(g, r, total))}
                      {c.delta && prior && g.key !== 'none' && <small className="em-d"><Delta d={pr ? delta(c.get(g, r, total), c.get(pg, pr, total)) : null} good="up" /></small>}
                    </td>
                  ))}
                </tr>
                {open.has(g.key) && subRows.map((s) => {
                  const sr = rates(s);
                  return (
                    <tr key={s.channel + '|' + s.type} className="em-msg">
                      <td><span className="em-name">{s.channel || '(none)'}</span>{s.type && <span className="em-status">{s.type}</span>}</td>
                      {CH_COLS.map((c) => <td key={c.key}>{g.key === 'none' && !['orders', 'sales'].includes(c.key) ? '' : c.fmt(c.get(s, sr, total))}</td>)}
                    </tr>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Landing pages by sessions, flagged when they convert at under half the site's rate. */
function LandingTable({ landing, siteConv, showBrand }) {
  const [sort, setSort] = useState({ key: 'sessions', dir: -1 });
  const [all, setAll] = useState(false);
  const cols = [
    { key: 'sessions', label: 'Sessions', get: (t) => t.sessions, fmt: count },
    { key: 'bounceRate', label: 'Bounce', get: (t, r) => r.bounceRate, fmt: pct },
    { key: 'cartRate', label: 'Cart', get: (t, r) => r.cartRate, fmt: pct },
    { key: 'convRate', label: 'Conv.', get: (t, r) => r.convRate, fmt: pct },
    { key: 'pagesPerSession', label: 'Pages', get: (t, r) => r.pagesPerSession, fmt: dec },
  ];
  const col = cols.find((c) => c.key === sort.key);
  const rows = landing.map((t) => ({ t, r: rates(t) }))
    .sort((a, b) => ((col.get(a.t, a.r) ?? -Infinity) - (col.get(b.t, b.r) ?? -Infinity)) * sort.dir);
  const shown = all ? rows : rows.slice(0, 15);
  return (
    <>
      <div className="pf-table-wrap flush">
        <table className="pf-table em-flows tr-landing">
          <thead>
            <tr>
              <th>Landing page</th>
              {cols.map((c) => (
                <th key={c.key}><button className="em-sort" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))}>
                  {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(({ t, r }) => {
              const leak = siteConv && t.sessions >= 100 && r.convRate != null && r.convRate < siteConv / 2;
              return (
                <tr key={t.brand + t.path}>
                  <td title={t.path}>
                    {showBrand && <i className="pf-dot" style={{ background: BRAND_COLOR[t.brand] || 'var(--muted)' }} title={t.brand} />}
                    <span className="em-name">{t.path}</span>
                    {leak && <span className="em-status tr-leak" title="100+ sessions converting at under half the overall rate">leaks</span>}
                  </td>
                  {cols.map((c) => <td key={c.key}>{c.fmt(c.get(t, r))}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 15 && (
        <button className="pf-chip small em-more" onClick={() => setAll((v) => !v)}>{all ? 'Show top 15' : 'Show all ' + rows.length}</button>
      )}
    </>
  );
}

function DeviceTable({ devices, total }) {
  const rows = [...devices].sort((a, b) => b.sessions - a.sessions);
  const cols = CH_COLS.filter((c) => !['orders', 'sales', 'revPerSession'].includes(c.key));
  return (
    <div className="pf-table-wrap flush">
      <table className="pf-table em-flows">
        <thead><tr><th>Device</th>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((d) => {
            const r = rates(d);
            return (
              <tr key={d.device}>
                <td><span className="em-name">{d.device.charAt(0).toUpperCase() + d.device.slice(1)}</span></td>
                {cols.map((c) => <td key={c.key}>{c.fmt(c.get(d, r, total))}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Traffic() {
  const ins = useInsights({ url: '/api/traffic', pnl: false });
  const { data, selected, period } = ins;
  const cur = useTraffic(data && period ? period.from : null, data && period ? period.to : null, false);
  const prior = useTraffic(cur.data && period && period.compare ? period.compare.from : null,
    cur.data && period && period.compare ? period.compare.to : null, true);

  const s = useMemo(() => (selected ? summarise(cur.data, selected) : null), [cur.data, selected]);
  const p = useMemo(() => (selected ? summarise(prior.data, selected) : null), [prior.data, selected]);
  const errors = cur.data && selected ? cur.data.brands.filter((b) => selected.includes(b.name) && b.error) : [];
  const siteConv = s ? rates(s.total).convRate : null;

  return (
    <div className="pane pf-pane">
      <InsightsHeader ins={ins} title="Traffic"
        sub="Sessions from Shopify Analytics: where they come from, how far they get, and what each one is worth." />

      {data && selected && period && (
        <>
          {errors.map((b) => <div className="pf-note" key={b.key}>{b.name}: {b.error}</div>)}
          {cur.error && <div className="approve-error">{cur.error}</div>}
          {!cur.data && cur.loading && <div className="risk-empty">Loading traffic from Shopify…</div>}
          {s && (
            <>
              <Tiles cur={s.total} prior={p && p.total} />
              <div className="pf-label pf-section-head">Funnel</div>
              <Funnel t={s.total} prior={p && p.total} />
              <div className="pf-label pf-section-head">Sessions</div>
              <SessionsChart daily={s.daily} from={period.from} to={period.to} />
              <div className="pf-label pf-section-head">By channel</div>
              <ChannelTable groups={s.groups} prior={p && p.groups} total={s.total} />
              <div className="pf-sub em-foot">
                Shopify's channel and traffic type for each session, grouped; open a channel for its sources. Conversion is
                sessions that completed checkout. Revenue is net sales Shopify credits to the session's channel, so revenue
                per session is what a visit from there is worth. "Unknown" traffic type is Shopify's own label, common for
                in-app browsers and bots.
              </div>
              <div className="pf-label pf-section-head">Landing pages</div>
              <LandingTable landing={s.landing} siteConv={siteConv} showBrand={selected.length > 1} />
              <div className="pf-sub em-foot">
                Top 60 landing pages per brand by sessions. "Leaks" marks a page with 100+ sessions converting at under half
                the overall rate. Shopify does not split revenue by landing page or device.
              </div>
              <div className="pf-label pf-section-head">Devices</div>
              <DeviceTable devices={s.devices} total={s.total} />
            </>
          )}
        </>
      )}
    </div>
  );
}
