'use client';
// The newest 50 orders per brand in the chosen period, each with its UTMs, landing page,
// referrer, Shopify's own source for the visit, the sales channel that took it, and the
// bucket the profit sheets' source rule gives it (the one Attribution sums). Owner-only
// through the orders area (lib/roles.js). Shares the Insights filter bar (app/insights.jsx).
//
// One request per period; brand toggles, the first/last visit switch and search filter
// on the device.
import { useEffect, useMemo, useState } from 'react';
import { SOURCES, addDays } from '../lib/profitMath';
import { useInsights, InsightsHeader, BRAND_COLOR, usd } from './insights';

// Same fixed palette as the Attribution tab, keyed by source, never by rank.
const COLOR = {
  meta: '#2a78d6', google: '#eb6834', social: '#1baf7a', search: '#eda100',
  email: '#e87ba4', referral: '#008300', direct: '#4a3aa7',
};
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.key, s.label]));
// Shopify's sourceName for orders that came through the online store, which say nothing more.
const WEB = ['web', ''];

function useOrders(from, to) {
  const [state, setState] = useState({ loading: false, data: null, error: '' });
  useEffect(() => {
    if (!from || !to) { setState({ loading: false, data: null, error: '' }); return undefined; }
    let dead = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    fetch(`/api/orders?from=${from}&to=${to}`).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (d.error) throw new Error(d.error);
      setState({ loading: false, data: d, error: '' });
    }).catch((e) => { if (!dead) setState({ loading: false, data: null, error: String(e.message || e) }); });
    return () => { dead = true; };
  }, [from, to]);
  return state;
}

const placed = (iso) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function pathOf(url) {
  if (!url) return '';
  try {
    const u = new URL(url, 'https://x.invalid');
    return u.pathname + (u.search ? '?…' : '');
  } catch { return url; }
}
function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Shopify's own description of the visit: "Facebook · paid", or what it has. */
function shopifySource(v) {
  if (!v) return '';
  const type = v.sourceType ? v.sourceType.toLowerCase().replace(/_/g, ' ') : '';
  return [v.source || v.description, type].filter(Boolean).join(' · ');
}

/** The sales channel, but only when it says more than "the online store". */
function salesChannel(o) {
  if (o.channel && !/^online store$/i.test(o.channel)) return o.channel;
  return WEB.includes(o.sourceName) ? (o.channel || 'Online Store') : o.sourceName;
}

const COLUMNS = [
  { key: 'utm_source', label: 'utm_source', get: (o, v) => v && v.utm.source },
  { key: 'utm_medium', label: 'utm_medium', get: (o, v) => v && v.utm.medium },
  { key: 'utm_campaign', label: 'utm_campaign', get: (o, v) => v && v.utm.campaign },
  { key: 'utm_content', label: 'utm_content', get: (o, v) => v && v.utm.content },
  { key: 'utm_term', label: 'utm_term', get: (o, v) => v && v.utm.term },
];

function csv(rows, visitKey) {
  const head = ['brand', 'order', 'placed', 'total', 'currency', 'sales_channel', 'source_name', 'shopify_source',
    'shopify_source_type', 'attribution_bucket', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'click_ids', 'landing_page', 'referrer', 'visit'];
  const cell = (x) => {
    const s = x == null ? '' : String(x);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = rows.map((o) => {
    const v = o[visitKey];
    return [o.brand, o.name, o.createdAt, o.total.toFixed(2), o.currency, salesChannel(o), o.sourceName,
      v && v.source, v && v.sourceType, SOURCE_LABEL[o.sheetSource] || o.sheetSource,
      v && v.utm.source, v && v.utm.medium, v && v.utm.campaign, v && v.utm.content, v && v.utm.term,
      v && v.clickIds.join(' '), v && v.landing, v && v.referrer, visitKey].map(cell).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Orders() {
  const ins = useInsights({ url: '/api/orders', pnl: false });
  const { data, selected, period } = ins;
  const cur = useOrders(data && period ? period.from : null, data && period ? period.to : null);
  const [visitKey, setVisitKey] = useState('last');
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState(null);

  const brands = cur.data && selected ? cur.data.brands.filter((b) => selected.includes(b.name)) : [];
  const all = useMemo(() => brands.filter((b) => !b.error)
    .flatMap((b) => b.orders.map((o) => ({ ...o, brand: b.name })))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)), [cur.data, selected]);  // brands derives from both

  const needle = query.trim().toLowerCase();
  const rows = all.filter((o) => {
    if (bucket && o.sheetSource !== bucket) return false;
    if (!needle) return true;
    const v = o[visitKey];
    const hay = [o.name, o.brand, salesChannel(o), shopifySource(v), SOURCE_LABEL[o.sheetSource],
      v && Object.values(v.utm).join(' '), v && v.landing, v && v.referrer].join(' ').toLowerCase();
    return hay.includes(needle);
  });
  const counts = all.reduce((m, o) => ({ ...m, [o.sheetSource]: (m[o.sheetSource] || 0) + 1 }), {});
  const tagged = all.filter((o) => o[visitKey] && Object.values(o[visitKey].utm).some(Boolean)).length;
  const errors = brands.filter((b) => b.error);
  const capped = brands.filter((b) => !b.error && b.orders.length >= (cur.data.limit || 50));
  // The apps lack read_all_orders, so Shopify only returns the last 60 days.
  const tooOld = data && period && period.from < addDays(data.today, -59);

  return (
    <div className="pane pf-pane">
      <InsightsHeader ins={ins} title="Orders" compare={false}
        sub="The newest 50 orders per brand in the period, with their UTMs, Shopify's source for the visit, and the Attribution bucket each one counts in." />

      {data && selected && period && (
        <>
          {errors.map((b) => <div className="pf-note" key={b.key}>{b.name}: {b.error}</div>)}
          {tooOld && <div className="pf-note">Shopify only returns orders from the last 60 days to this app, so anything earlier is missing.</div>}
          {cur.error && <div className="approve-error">{cur.error}</div>}
          {cur.loading && <div className="risk-empty">Loading orders from Shopify…</div>}

          {cur.data && !cur.loading && (
            <>
              <div className="pf-toolbar od-toolbar">
                <div className="pf-group">
                  <div className="pf-filter-label">Visit</div>
                  <div className="pf-chips" role="group" aria-label="Which visit">
                    {[['last', 'Last visit'], ['first', 'First visit']].map(([k, l]) => (
                      <button key={k} className={'pf-chip' + (visitKey === k ? ' on' : '')} aria-pressed={visitKey === k}
                        onClick={() => setVisitKey(k)}>{l}</button>
                    ))}
                  </div>
                </div>
                <div className="pf-group od-search">
                  <div className="pf-filter-label">Search</div>
                  <input className="input ibx-search" type="search" placeholder="Order, campaign, source, landing page"
                    value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              </div>

              <div className="pf-chips od-buckets" role="group" aria-label="Attribution bucket">
                <button className={'pf-chip small' + (!bucket ? ' on' : '')} aria-pressed={!bucket} onClick={() => setBucket(null)}>
                  All {all.length}
                </button>
                {SOURCES.filter((s) => counts[s.key]).map((s) => (
                  <button key={s.key} className={'pf-chip small' + (bucket === s.key ? ' on' : '')} aria-pressed={bucket === s.key}
                    onClick={() => setBucket((b) => (b === s.key ? null : s.key))}>
                    <i style={{ background: COLOR[s.key] }} />{s.label} {counts[s.key]}
                  </button>
                ))}
              </div>
              <div className="pf-sub od-meta">
                {rows.length} shown · {tagged} of {all.length} have UTMs on the {visitKey} visit
                {capped.length > 0 && <> · {capped.map((b) => b.name).join(', ')} had more than {cur.data.limit} orders in the period; these are the newest</>}
                {rows.length > 0 && (
                  <button className="pf-chip small od-csv"
                    onClick={() => download(`orders-${period.from}-to-${period.to}.csv`, csv(rows, visitKey))}>Download CSV</button>
                )}
              </div>

              {rows.length === 0 ? (
                <div className="risk-empty">{all.length ? 'No orders match.' : 'No orders in this period.'}</div>
              ) : (
                <div className="pf-table-wrap">
                  <table className="pf-table od-table">
                    <thead>
                      <tr>
                        <th>Order</th><th>Placed</th><th>Total</th><th>Sales channel</th><th>Shopify source</th>
                        <th>Attribution</th>
                        {COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}
                        <th>Click ids</th><th>Landing page</th><th>Referrer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((o) => {
                        const v = o[visitKey];
                        return (
                          <tr key={o.brand + o.id} className={o.cancelled ? 'od-cancelled' : ''}>
                            <td>
                              {selected.length > 1 && <i className="pf-dot" style={{ background: BRAND_COLOR[o.brand] || 'var(--muted)' }} title={o.brand} />}
                              {o.adminUrl ? <a href={o.adminUrl} target="_blank" rel="noreferrer">{o.name}</a> : o.name}
                              {o.cancelled && <span className="em-status">cancelled</span>}
                            </td>
                            <td>{placed(o.createdAt)}</td>
                            <td>{usd(o.total, 2)}</td>
                            <td>{salesChannel(o)}</td>
                            <td>{v ? shopifySource(v) || '—' : <span className="od-none" title="Shopify recorded no storefront visit for this order (draft orders, Shop app, imports)">no visit</span>}</td>
                            <td><i className="pf-dot" style={{ background: COLOR[o.sheetSource] || 'var(--muted)' }} />{SOURCE_LABEL[o.sheetSource] || o.sheetSource}</td>
                            {COLUMNS.map((c) => <td key={c.key} title={c.get(o, v) || ''}>{c.get(o, v) || <span className="od-none">—</span>}</td>)}
                            <td>{v && v.clickIds.length ? v.clickIds.join(', ') : <span className="od-none">—</span>}</td>
                            <td title={v ? v.landing : ''}>{v && v.landing ? pathOf(v.landing) : <span className="od-none">—</span>}</td>
                            <td title={v ? v.referrer : ''}>{v && v.referrer ? hostOf(v.referrer) : <span className="od-none">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="pf-sub em-foot">
                Shopify source is Shopify's own record of the visit that led to the order, as on the order page in the admin;
                UTMs are Shopify's parsed parameters, or read off the landing page when it has none. Attribution is the bucket
                the profit sheets' rule puts the order in, from its last visit, so it matches the Attribution tab whichever
                visit is shown. Sales channel is where the order was placed. Hover a cell for the full value.
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
