'use client';
// Email, from each brand's own Klaviyo account (lib/klaviyo.js): how many people each brand
// can email, how that list is moving, and how every flow performs. Owner-only through the
// email area (lib/roles.js). Shares the Insights filter bar and remembered filters
// (app/insights.jsx).
//
// List data arrives once and is sliced here. Flows are fetched per period, because Klaviyo
// computes uniques and attribution over the exact range; brand toggles filter what is
// already loaded. The flow report is rate-limited to 2 calls a minute per account, so a
// refused call is retried after Klaviyo's own wait rather than shown as a failure.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { bucketUnit, bucketKey, addDays } from '../lib/profitMath';
import { useInsights, InsightsHeader, BRAND_COLOR, usd, pct, count, delta, Delta, shortDate } from './insights';

const UP = '#1baf7a';
const DOWN = '#d64545';

const KIND_LABEL = {
  emailable: 'All emailable profiles',
  subscribed: 'Subscribed only, not all emailable',
  custom: 'Custom segment',
};

/** Subscribes and unsubscribes for the chosen brands over [from, to]. */
function motion(rows, brands, from, to) {
  const set = new Set(brands);
  let subscribed = 0, unsubscribed = 0;
  for (const r of rows) {
    if (r.date < from || r.date > to || !set.has(r.brand)) continue;
    subscribed += r.subscribed;
    unsubscribed += r.unsubscribed;
  }
  return { subscribed, unsubscribed, net: subscribed - unsubscribed };
}

function GrowthTiles({ lists, rows, selected, period, today }) {
  const shown = lists.filter((l) => selected.includes(l.name) && l.subscribers != null);
  const now = shown.reduce((n, l) => n + l.subscribers, 0);
  const cur = motion(rows, selected, period.from, period.to);
  const prior = period.compare ? motion(rows, selected, period.compare.from, period.compare.to) : null;
  // The list at the start of the period: today's count with everything since undone.
  const since = motion(rows, selected, period.from, today);
  const start = now - since.net;
  const rate = start > 0 ? cur.net / start : null;
  const tiles = [
    { label: 'Subscribers now', value: shown.length ? count(now) : '—', hero: true,
      sub: shown.length < selected.length ? 'Not every selected brand is connected' : 'Live from Klaviyo' },
    { label: 'Net growth', value: (cur.net > 0 ? '+' : '') + count(cur.net), d: prior && delta(cur.net, prior.net), good: 'up',
      sub: rate == null ? null : (rate >= 0 ? '+' : '') + pct(rate) + ' of the list' },
    { label: 'New subscribers', value: count(cur.subscribed), d: prior && delta(cur.subscribed, prior.subscribed), good: 'up' },
    { label: 'Unsubscribes', value: count(cur.unsubscribed), d: prior && delta(cur.unsubscribed, prior.unsubscribed), good: 'down',
      sub: cur.subscribed ? count(cur.unsubscribed / cur.subscribed * 100) + ' per 100 new' : null },
  ];
  return (
    <div className="pf-tiles">
      {tiles.map((t) => (
        <div className={'pf-tile' + (t.hero ? ' hero' : '')} key={t.label}>
          <div className="pf-label">{t.label}</div>
          <div className="pf-value">{t.value}</div>
          {prior && t.d !== undefined && <Delta d={t.d} good={t.good} />}
          {t.sub && <div className="pf-sub">{t.sub}</div>}
        </div>
      ))}
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

/** New subscribers above the line, unsubscribes below, per day / week / month. */
function GrowthChart({ rows, selected, from, to }) {
  const unit = bucketUnit(from, to);
  const buckets = useMemo(() => {
    const map = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const k = bucketKey(d, unit);
      if (!map.has(k)) map.set(k, { date: k, subscribed: 0, unsubscribed: 0 });
    }
    const set = new Set(selected);
    for (const r of rows) {
      if (r.date < from || r.date > to || !set.has(r.brand)) continue;
      const b = map.get(bucketKey(r.date, unit));
      b.subscribed += r.subscribed;
      b.unsubscribed += r.unsubscribed;
    }
    return [...map.values()];
  }, [rows, selected, from, to, unit]);
  const [hover, setHover] = useState(null);
  const [box, W] = useWidth();

  const H = W < 500 ? 210 : 250, padL = 44, padR = 8, padT = 10, padB = 26;
  const top = Math.max(1, ...buckets.map((b) => b.subscribed));
  const bot = Math.max(1, ...buckets.map((b) => b.unsubscribed));
  const span = top + bot;
  const zero = padT + (top / span) * (H - padT - padB);
  const scale = (H - padT - padB) / span;
  const slot = (W - padL - padR) / buckets.length;
  const gap = slot > 6 ? 2 : 0;
  const barW = Math.max(1, slot - gap);
  const labelEvery = Math.ceil(buckets.length / (W < 500 ? 4 : 7));
  const fmtX = (iso) => (unit === 'month' ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : iso.slice(5));
  const h = hover != null ? buckets[hover] : null;

  return (
    <div className="pf-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={'New subscribers and unsubscribes per ' + unit}>
        <line x1={padL} x2={W - padR} y1={padT} y2={padT} className="pf-grid" />
        <text x={padL - 8} y={padT + 4} className="pf-axis" textAnchor="end">{count(top)}</text>
        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} className="pf-grid" />
        <text x={padL - 8} y={H - padB + 4} className="pf-axis" textAnchor="end">-{count(bot)}</text>
        {buckets.map((b, i) => {
          const x = padL + i * slot + gap / 2;
          const dim = hover == null || hover === i ? 1 : 0.5;
          return (
            <g key={b.date}>
              {b.subscribed > 0 && <rect x={x} y={zero - b.subscribed * scale} width={barW} height={b.subscribed * scale} fill={UP} opacity={dim} />}
              {b.unsubscribed > 0 && <rect x={x} y={zero} width={barW} height={b.unsubscribed * scale} fill={DOWN} opacity={dim} />}
              <rect x={padL + i * slot} y={padT} width={slot} height={H - padT - padB} fill="transparent" tabIndex={0}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onTouchStart={() => setHover(i)}
                aria-label={b.date + ': ' + b.subscribed + ' new, ' + b.unsubscribed + ' unsubscribed'} />
              {i % labelEvery === 0 && <text x={x + barW / 2} y={H - 8} className="pf-axis" textAnchor="middle">{fmtX(b.date)}</text>}
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={zero} y2={zero} className="pf-zero" />
      </svg>
      {h && (
        <div className="pf-tip at-tip" style={{ left: `${Math.min(80, Math.max(20, ((padL + hover * slot + slot / 2) / W) * 100))}%` }}>
          <strong>{(h.subscribed - h.unsubscribed > 0 ? '+' : '') + count(h.subscribed - h.unsubscribed)} net</strong>
          <span>{unit === 'day' ? h.date : (unit === 'week' ? 'Week of ' + shortDate(h.date) : fmtX(h.date) + ' ' + h.date.slice(0, 4))}</span>
          <span className="at-tip-row"><i style={{ background: UP }} />New<b>{count(h.subscribed)}</b></span>
          <span className="at-tip-row"><i style={{ background: DOWN }} />Unsubscribed<b>{count(h.unsubscribed)}</b></span>
        </div>
      )}
      <div className="at-chart-unit">
        <span className="em-key"><i style={{ background: UP }} />New</span>
        <span className="em-key"><i style={{ background: DOWN }} />Unsubscribed</span>
        Per {unit}
      </div>
    </div>
  );
}

/** Total subscribers per day, from the counts Backstage has recorded. Absent until a week exists. */
function TotalLine({ snapshots, selected, from, to }) {
  const series = useMemo(() => {
    const set = new Set(selected);
    const byDay = new Map();
    for (const s of snapshots) {
      if (s.date < from || s.date > to || !set.has(s.brand)) continue;
      const d = byDay.get(s.date) || { date: s.date, total: 0, brands: 0 };
      d.total += s.subscribers;
      d.brands += 1;
      byDay.set(s.date, d);
    }
    // Only days where every selected brand was counted, or the sum would dip on gaps.
    const brandsWithData = new Set(snapshots.filter((s) => set.has(s.brand)).map((s) => s.brand)).size;
    return [...byDay.values()].filter((d) => d.brands === brandsWithData).sort((a, b) => a.date.localeCompare(b.date));
  }, [snapshots, selected, from, to]);
  const first = snapshots.filter((s) => selected.includes(s.brand)).map((s) => s.date).sort()[0];
  const [box, W] = useWidth();
  const [hover, setHover] = useState(null);

  if (series.length < 7) {
    return (
      <div className="pf-channels-empty">
        Klaviyo keeps no history of the subscriber total, so Backstage records it daily
        {first ? ' (since ' + shortDate(first) + ')' : ''}. A line appears here once a week of counts falls in this period.
      </div>
    );
  }
  const H = 160, padL = 56, padR = 10, padT = 10, padB = 22;
  const lo = Math.min(...series.map((d) => d.total)), hi = Math.max(...series.map((d) => d.total));
  const pad = Math.max(1, (hi - lo) * 0.1);
  const y = (v) => padT + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - padT - padB);
  const x = (i) => padL + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - padL - padR));
  const d = series.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.total).toFixed(1)).join(' ');
  const h = hover != null ? series[hover] : null;
  return (
    <div className="pf-chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Total subscribers per day">
        {[hi, lo].map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="pf-grid" />
            <text x={padL - 8} y={y(t) + 4} className="pf-axis" textAnchor="end">{count(t)}</text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--blue)" strokeWidth="2" />
        {series.map((p, i) => (
          <rect key={p.date} x={x(i) - (W / series.length) / 2} y={padT} width={W / series.length} height={H - padT - padB}
            fill="transparent" onMouseEnter={() => setHover(i)} onTouchStart={() => setHover(i)} />
        ))}
        {h && <circle cx={x(hover)} cy={y(h.total)} r="4" fill="var(--blue)" />}
        <text x={padL} y={H - 6} className="pf-axis">{shortDate(series[0].date)}</text>
        <text x={W - padR} y={H - 6} className="pf-axis" textAnchor="end">{shortDate(series[series.length - 1].date)}</text>
      </svg>
      {h && (
        <div className="pf-tip at-tip" style={{ left: `${Math.min(80, Math.max(20, (x(hover) / W) * 100))}%` }}>
          <strong>{count(h.total)}</strong><span>{h.date}</span>
        </div>
      )}
    </div>
  );
}

function BrandTable({ lists, rows, selected, period, today, onOnly }) {
  const shown = lists.filter((l) => selected.includes(l.name));
  return (
    <div className="pf-table-wrap flush">
      <table className="pf-table pf-brand-table">
        <thead>
          <tr><th>Brand</th><th>Subscribers</th><th>New</th><th>Unsubscribed</th><th>Net</th><th>Growth</th><th>Counted as</th></tr>
        </thead>
        <tbody>
          {shown.map((l) => {
            const m = motion(rows, [l.name], period.from, period.to);
            const since = motion(rows, [l.name], period.from, today);
            const start = l.subscribers != null ? l.subscribers - since.net : null;
            return (
              <tr key={l.key} onClick={() => onOnly(l.name)} title={'Show only ' + l.name} tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onOnly(l.name); }}>
                <td><i className="pf-dot" style={{ background: BRAND_COLOR[l.name] || 'var(--muted)' }} />{l.name}</td>
                <td>{l.subscribers != null ? count(l.subscribers) : '—'}</td>
                <td>{count(m.subscribed)}</td>
                <td>{count(m.unsubscribed)}</td>
                <td className={m.net < 0 ? 'neg' : ''}>{(m.net > 0 ? '+' : '') + count(m.net)}</td>
                <td>{start > 0 ? (m.net >= 0 ? '+' : '') + pct(m.net / start) : '—'}</td>
                <td className="em-seg">{l.segment ? l.segment.name : (l.configured && !l.error ? 'No segment found' : '—')}
                  {l.segment && <small>{KIND_LABEL[l.segment.kind]}</small>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ----- flows -----

const rate = (n, d) => (d ? n / d : null);

/** Rates from summed counts. Opens only exist for email, so open rate uses email delivered. */
function flowRates(f) {
  const msgs = f.messages || [f];
  const emailDelivered = msgs.filter((m) => (m.channel || 'email') === 'email').reduce((n, m) => n + m.delivered, 0);
  return {
    openRate: rate(f.opens_unique, emailDelivered),
    clickRate: rate(f.clicks_unique, f.delivered),
    orderRate: rate(f.conversion_uniques, f.delivered),
    unsubRate: rate(f.unsubscribe_uniques, f.delivered),
    perRecipient: rate(f.conversion_value, f.delivered),
  };
}

const COLUMNS = [
  { key: 'recipients', label: 'Recipients', get: (f) => f.recipients, fmt: count },
  { key: 'openRate', label: 'Open rate', get: (f, r) => r.openRate, fmt: pct },
  { key: 'clickRate', label: 'Click rate', get: (f, r) => r.clickRate, fmt: pct },
  { key: 'orderRate', label: 'Order rate', get: (f, r) => r.orderRate, fmt: pct },
  { key: 'orders', label: 'Orders', get: (f) => f.conversions, fmt: count },
  { key: 'revenue', label: 'Revenue', get: (f) => f.conversion_value, fmt: (v) => usd(v) },
  { key: 'perRecipient', label: 'Per recipient', get: (f, r) => r.perRecipient, fmt: (v) => usd(v, 2) },
  { key: 'unsubRate', label: 'Unsub rate', get: (f, r) => r.unsubRate, fmt: pct },
];

function FlowTiles({ flows }) {
  const t = flows.reduce((a, f) => {
    for (const k of ['recipients', 'delivered', 'opens_unique', 'clicks_unique', 'conversions', 'conversion_uniques', 'conversion_value', 'unsubscribe_uniques']) a[k] += f[k];
    a.messages.push(...f.messages);
    return a;
  }, { recipients: 0, delivered: 0, opens_unique: 0, clicks_unique: 0, conversions: 0, conversion_uniques: 0, conversion_value: 0, unsubscribe_uniques: 0, messages: [] });
  const r = flowRates(t);
  const tiles = [
    { label: 'Flow revenue', value: usd(t.conversion_value), sub: count(t.conversions) + ' orders', hero: true },
    { label: 'Recipients', value: count(t.recipients), sub: usd(r.perRecipient, 2) + ' per recipient' },
    { label: 'Open rate', value: pct(r.openRate), sub: 'Click rate ' + pct(r.clickRate) },
    { label: 'Order rate', value: pct(r.orderRate), sub: 'Unsub rate ' + pct(r.unsubRate) },
  ];
  return (
    <div className="pf-tiles">
      {tiles.map((x) => (
        <div className={'pf-tile' + (x.hero ? ' hero' : '')} key={x.label}>
          <div className="pf-label">{x.label}</div>
          <div className="pf-value">{x.value}</div>
          {x.sub && <div className="pf-sub">{x.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function FlowTable({ flows, showBrand }) {
  const [sort, setSort] = useState({ key: 'revenue', dir: -1 });
  const [open, setOpen] = useState(() => new Set());
  const [showQuiet, setShowQuiet] = useState(false);
  const col = COLUMNS.find((c) => c.key === sort.key);
  const withRates = flows.map((f) => ({ f, r: flowRates(f) }));
  const active = withRates.filter(({ f }) => f.recipients > 0);
  const rows = (showQuiet ? withRates : active)
    .sort((a, b) => ((col.get(a.f, a.r) ?? -Infinity) - (col.get(b.f, b.r) ?? -Infinity)) * sort.dir);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (!flows.length) return <div className="risk-empty">No flows sent anything in this period.</div>;
  return (
    <>
      <div className="pf-table-wrap flush">
        <table className="pf-table em-flows">
          <thead>
            <tr>
              <th>Flow</th>
              {COLUMNS.map((c) => (
                <th key={c.key} aria-sort={sort.key === c.key ? (sort.dir < 0 ? 'descending' : 'ascending') : undefined}>
                  <button className="em-sort" onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))}>
                    {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, r }) => (
              <Fragment key={f.brandKey + f.id}>
                <tr className="em-flow" onClick={() => toggle(f.brandKey + f.id)} tabIndex={0} aria-expanded={open.has(f.brandKey + f.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(f.brandKey + f.id); }}>
                  <td>
                    <span className={'pf-chev' + (open.has(f.brandKey + f.id) ? ' open' : '')}>›</span>
                    {showBrand && <i className="pf-dot" style={{ background: BRAND_COLOR[f.brand] || 'var(--muted)' }} title={f.brand} />}
                    <span className="em-name">{f.name}</span>
                    {f.status !== 'live' && <span className="em-status">{f.status}</span>}
                  </td>
                  {COLUMNS.map((c) => <td key={c.key}>{c.fmt(c.get(f, r))}</td>)}
                </tr>
                {open.has(f.brandKey + f.id) && f.messages.map((m) => {
                  const mr = flowRates({ ...m, messages: [m] });
                  return (
                    <tr key={m.id} className="em-msg">
                      <td><span className="em-name">{m.name}</span>{m.channel !== 'email' && <span className="em-status">{m.channel}</span>}</td>
                      {COLUMNS.map((c) => <td key={c.key}>{c.fmt(c.get(m, mr))}</td>)}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {active.length < withRates.length && (
        <button className="pf-chip small em-more" onClick={() => setShowQuiet((v) => !v)}>
          {showQuiet ? 'Hide' : 'Show'} {withRates.length - active.length} flow{withRates.length - active.length === 1 ? '' : 's'} that sent nothing
        </button>
      )}
    </>
  );
}

/** Flow reports for the period, retried after Klaviyo's wait when it rate-limits. */
function useFlows(period) {
  const [state, setState] = useState({ loading: false, data: null, error: '', waiting: 0 });
  const from = period && period.from, to = period && period.to;
  useEffect(() => {
    if (!from || !to) return undefined;
    let dead = false, timer = null, tries = 0;
    const load = () => {
      setState((s) => ({ ...s, loading: true, error: '', waiting: 0 }));
      fetch(`/api/email?flows=1&from=${from}&to=${to}`).then((r) => r.json()).then((d) => {
        if (dead) return;
        if (d.error) throw new Error(d.error);
        const limited = d.flows.filter((b) => b.rateLimited);
        setState({ loading: false, data: d, error: '', waiting: limited.length && tries < 3 ? Math.max(...limited.map((b) => b.retryAfter || 60)) : 0 });
        if (limited.length && tries < 3) {
          tries += 1;
          timer = setTimeout(load, Math.min(75, Math.max(...limited.map((b) => b.retryAfter || 60))) * 1000 + 500);
        }
      }).catch((e) => { if (!dead) setState({ loading: false, data: null, error: String(e.message || e), waiting: 0 }); });
    };
    load();
    return () => { dead = true; clearTimeout(timer); };
  }, [from, to]);
  return state;
}

export default function Email() {
  const ins = useInsights({ url: '/api/email', pnl: false });
  const { data, selected, setSelected, period, view } = ins;
  const flowsState = useFlows(data && period ? period : null);

  const notes = data ? data.lists.filter((l) => selected && selected.includes(l.name)).map((l) => {
    if (!l.configured) return l.name + ' is not connected: add ' + l.key.toUpperCase() + '_KLAVIYO_API_KEY in Vercel.';
    if (l.error) return l.name + ': ' + l.error;
    if (!l.segment) return l.name + ' has no "All Emailable Profiles" segment in Klaviyo, so there is no total. Create one with the single condition "Can receive email marketing", or set ' + l.key.toUpperCase() + '_KLAVIYO_SEGMENT_ID.';
    if (l.segment.kind !== 'emailable') return l.name + ' is counting "' + l.segment.name + '", which is not all emailable profiles. Create an "All Emailable Profiles" segment (single condition "Can receive email marketing") and it will be used instead.';
    if (l.missingMetrics && l.missingMetrics.length) return l.name + ' has no "' + l.missingMetrics.join('" or "') + '" events yet, so its growth reads as zero.';
    return null;
  }).filter(Boolean) : [];

  const flows = useMemo(() => {
    const d = flowsState.data;
    if (!d || !selected) return [];
    return d.flows.filter((b) => selected.includes(b.name) && b.flows)
      .flatMap((b) => b.flows.map((f) => ({ ...f, brand: b.name, brandKey: b.key })));
  }, [flowsState.data, selected]);
  const flowNotes = flowsState.data && selected ? flowsState.data.flows.filter((b) => selected.includes(b.name) && b.configured).map((b) => {
    if (b.rateLimited) return b.name + ': Klaviyo allows 2 flow reports a minute. ' + (flowsState.waiting ? 'Trying again in about ' + Math.min(75, flowsState.waiting) + ' seconds.' : 'Try again shortly.');
    if (b.error) return b.name + ': ' + b.error;
    if (b.clamped) return b.name + ': Klaviyo reports at most a year, so flows cover ' + shortDate(b.from) + ' onward.';
    if (b.stale) return b.name + ': Klaviyo refused a fresh report, so these flow numbers are from ' + new Date(b.fetchedAt).toLocaleString() + '.';
    return null;
  }).filter(Boolean) : [];

  return (
    <div className="pane pf-pane">
      <InsightsHeader ins={ins} title="Email"
        sub="List growth and flow performance from each brand's Klaviyo account." />

      {data && selected && period && view && (
        <>
          {notes.map((n) => <div className="pf-note" key={n}>{n}</div>)}
          <GrowthTiles lists={data.lists} rows={data.rows} selected={selected} period={period} today={data.today} />
          <div className="pf-label pf-section-head">List growth</div>
          <GrowthChart rows={data.rows} selected={selected} from={period.from} to={period.to} />
          <div className="pf-label pf-section-head">By brand</div>
          <BrandTable lists={data.lists} rows={data.rows} selected={selected} period={period} today={data.today}
            onOnly={(b) => setSelected([b])} />
          <div className="pf-sub em-foot">
            New and unsubscribed are Klaviyo's email consent events. Bounces and suppressions also shrink the list without an
            unsubscribe, so the live total is the one to trust.
          </div>
          <div className="pf-label pf-section-head">Total subscribers</div>
          <TotalLine snapshots={data.snapshots} selected={selected} from={period.from} to={period.to} />

          <div className="pf-label pf-section-head em-flows-head">Flows</div>
          {flowNotes.map((n) => <div className="pf-note" key={n}>{n}</div>)}
          {flowsState.error && <div className="approve-error">{flowsState.error}</div>}
          {!flowsState.data && flowsState.loading && <div className="risk-empty">Loading flow reports from Klaviyo…</div>}
          {flowsState.data && (
            <>
              <FlowTiles flows={flows} />
              <FlowTable flows={flows} showBrand={selected.length > 1} />
              <div className="pf-sub em-foot">
                Klaviyo's numbers by send date, orders on Klaviyo's attribution (Placed Order). Rates use delivered; open rate
                uses email only. Click a flow for its messages.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
