'use client';
import { useEffect, useMemo, useState } from 'react';
import Builder from './Builder';
import Mockups from './Mockups';
import Settings from './Settings';

const BRANDS = {
  elderemo:  { name: 'Elder Emo', color: 'var(--violet)', bg: 'var(--violet-bg)' },
  poppunks:  { name: 'PopPunks',  color: 'var(--pink)',   bg: 'var(--pink-bg)' },
  wallspoke: { name: 'Wallspoke', color: 'var(--blue)',   bg: 'var(--blue-bg)' },
  unknown:   { name: 'Unknown',   color: 'var(--muted)',  bg: 'var(--surface-2)' },
};
const RAIL_BRANDS = ['elderemo', 'poppunks', 'wallspoke'];
const STATUS = {
  shipped:    { cls: 's-shipped',    dot: 'var(--green)', label: 'Shipped' },
  production: { cls: 's-production', dot: 'var(--amber)', label: 'In production' },
  action:     { cls: 's-action',     dot: 'var(--red)',   label: 'Needs action' },
};
const FULFILLER = { you: 'Fulfilled by You', printify: 'Printify', gelato: 'Gelato', printful: 'Printful' };

function worst(items = []) {
  if (items.some((i) => i.status === 'action')) return 'action';
  if (items.some((i) => i.status === 'production')) return 'production';
  return 'shipped';
}
function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return mins + 'm';
  if (mins < 1440) return Math.floor(mins / 60) + 'h';
  return Math.floor(mins / 1440) + 'd';
}
function normalize(r) {
  const os = r.order_status || {};
  return {
    id: r.id, brand: r.brand in BRANDS ? r.brand : 'unknown',
    from: r.from_email, to: r.to_email, time: timeAgo(r.received_at),
    type: r.issue_type || 'General question', summary: r.summary || '', original: r.body || '',
    order: r.order_number || os.orderNumber, placed: os.placedAt || '',
    items: os.items || [], shopifyUrl: os.shopifyAdminUrl || null,
    needsAction: r.needs_action, draft: r.draft_reply || '', resolvedAt: r.resolved_at || null,
    confidence: typeof r.confidence === 'number' ? r.confidence.toFixed(2) : r.confidence,
  };
}
function normalizeRisk(r) {
  return {
    id: r.order_id, brand: r.brand in BRANDS ? r.brand : 'unknown',
    order: r.order_number, customer: r.customer_name || r.customer_email || 'Unknown customer',
    items: r.items || '', reasons: r.reasons || [], severity: r.severity || 'medium',
    ruleKey: r.rule_key, age: r.age_days, url: r.shopify_admin_url,
  };
}

export default function Page() {
  const [tab, setTab] = useState('inbox');
  const [rows, setRows] = useState([]);
  const [risk, setRisk] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(null);
  const [copied, setCopied] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState({}); // local per-inquiry edited reply text
  const [me, setMe] = useState(null);
  const [filter, setFilter] = useState('all'); // all | <brandKey> | needs | resolved
  const [resolvedRows, setResolvedRows] = useState([]);
  const [resolvedLoaded, setResolvedLoaded] = useState(false);

  function loadOpen() {
    return fetch('/api/inquiries').then((r) => r.json()).then((d) => {
      const n = (d.inquiries || []).map(normalize);
      setRows(n);
      setSelected((sel) => sel || (n.length ? n[0].id : null));
    }).catch(() => {});
  }
  function loadResolved() {
    return fetch('/api/inquiries?status=resolved').then((r) => r.json()).then((d) => {
      setResolvedRows((d.inquiries || []).map(normalize));
      setResolvedLoaded(true);
    }).catch(() => {});
  }
  useEffect(() => {
    fetch('/api/me').then((r) => r.json()).then((d) => setMe(d.user || null)).catch(() => {});
    Promise.all([
      loadOpen(),
      fetch('/api/risk-orders').then((r) => r.json()).then((d) => {
        setRisk((d.riskOrders || []).map(normalizeRisk));
      }).catch(() => {}),
    ]).finally(() => setLoaded(true));
  }, []);

  function selectFilter(f) {
    setFilter(f);
    setSelected(null);
    if (f === 'resolved' && !resolvedLoaded) loadResolved();
  }

  const displayed = useMemo(() => {
    if (filter === 'resolved') return resolvedRows;
    if (filter === 'needs') return rows.filter((r) => r.needsAction);
    if (filter !== 'all') return rows.filter((r) => r.brand === filter);
    return rows;
  }, [filter, rows, resolvedRows]);
  const viewingResolved = filter === 'resolved';
  const current = useMemo(() => displayed.find((r) => r.id === selected) || displayed[0] || null, [displayed, selected]);
  const actionCount = rows.filter((r) => r.needsAction).length;
  const riskHigh = risk.filter((r) => r.severity === 'high').length;
  const counts = {};
  for (const r of rows) counts[r.brand] = (counts[r.brand] || 0) + 1;

  function openInquiry(id) { setSelected(id); setMobileDetail(true); setEditing(false); }
  function copyReply() {
    const text = (drafts[current.id] != null ? drafts[current.id] : current.draft);
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
    else done();
  }
  function dismissRisk(r) {
    setRisk((prev) => prev.filter((x) => x.id !== r.id));
    fetch('/api/risk-dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: r.id, ruleKey: r.ruleKey }),
    }).catch(() => {});
  }
  function resolveInquiry(id) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setSelected(null);
    setResolvedLoaded(false); // history will refetch next time it is opened
    setMobileDetail(false);
    fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }
  function reopenInquiry(id) {
    setResolvedRows((prev) => prev.filter((r) => r.id !== id));
    setSelected(null);
    setMobileDetail(false);
    fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'reopen' }),
    }).then(() => loadOpen()).catch(() => {});
  }

  // Defined once and rendered twice: topbar tabs on desktop, bottom nav on mobile.
  const TABS = [
    { key: 'inbox', label: 'Inbox', short: 'Inbox', icon: '\u2709' },
    { key: 'risk', label: 'At risk', short: 'At risk', icon: '\u26A0' },
    { key: 'builder', label: 'Builder', short: 'Builder', icon: '\u2726' },
    { key: 'mockups', label: 'Mockups', short: 'Mockups', icon: '\u2751' },
    { key: 'settings', label: 'Settings', short: 'Settings', icon: '\u2699' },
  ];
  const badgeFor = (key) => (key === 'inbox' ? actionCount : key === 'risk' ? riskHigh : 0);

  // Likewise for the filters: the desktop rail and the mobile chip row are the same list.
  const FILTERS = [
    { key: 'all', group: 'brand', label: 'All inboxes', short: 'All', color: 'var(--action)', count: rows.length },
    ...RAIL_BRANDS.map((b) => ({
      key: b, group: 'brand', label: BRANDS[b].name, short: BRANDS[b].name,
      color: BRANDS[b].color, count: counts[b] || 0,
    })),
    { key: 'needs', group: 'view', label: 'Needs action', short: 'Needs action', color: 'var(--red)', count: actionCount },
    { key: 'resolved', group: 'view', label: 'Resolved', short: 'Resolved', color: 'var(--faint)', count: resolvedLoaded ? resolvedRows.length : '' },
  ];

  const vendorLinks = current ? [
    current.items.find((i) => i.fulfiller === 'printify' && i.vendorLink),
    current.items.find((i) => i.fulfiller === 'gelato' && i.vendorLink),
    current.items.find((i) => i.fulfiller === 'printful' && i.vendorLink),
  ].filter(Boolean) : [];

  return (
    <div className="app">
      <div className="topbar">
        <div className="wordmark">Backstage</div>
        <div className="tabs topbar-tabs" style={{ marginLeft: 8 }}>
          {TABS.map((t) => (
            <button key={t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              {t.label}{badgeFor(t.key) > 0 && <span className="badge">{badgeFor(t.key)}</span>}
            </button>
          ))}
        </div>
        <div className="spacer" />
        {me && (
          <button className="tab" title={me.email + (me.role === 'admin' ? ' (admin)' : '')}
            onClick={() => fetch('/api/auth/logout', { method: 'POST' }).then(() => { window.location.href = '/login'; })}>
            Sign out
          </button>
        )}
        <div className="avatar" title={me ? me.email : ''}>
          {me && me.email ? me.email[0].toUpperCase() : 'M'}
        </div>
      </div>

      {tab === 'inbox' && (
        <div className={'shell ' + (mobileDetail ? 'show-detail' : 'show-queue')}>
          <aside className="rail">
            <div className="eyebrow">Brands</div>
            {FILTERS.filter((f) => f.group === 'brand').map((f) => (
              <div className={'filter' + (filter === f.key ? ' active' : '')} key={f.key} onClick={() => selectFilter(f.key)}>
                <span className="dot" style={{ background: f.color }} />{f.label} <span className="n">{f.count}</span>
              </div>
            ))}
            <div className="eyebrow" style={{ marginTop: 22 }}>View</div>
            {FILTERS.filter((f) => f.group === 'view').map((f) => (
              <div className={'filter' + (filter === f.key ? ' active' : '')} key={f.key} onClick={() => selectFilter(f.key)}>
                <span className="dot" style={{ background: f.color }} />{f.label} <span className="n">{f.count}</span>
              </div>
            ))}
          </aside>

          <section className="queue">
            {/* The rail is hidden on phones, so the same filters appear as a scrollable
                chip row. Without this there is no way to filter on mobile at all. */}
            <div className="chipbar">
              {FILTERS.map((f) => (
                <button key={f.key} className={'chip' + (filter === f.key ? ' active' : '')} onClick={() => selectFilter(f.key)}>
                  <span className="dot" style={{ background: f.color }} />
                  {f.short}
                  {f.count !== '' && <span className="chip-n">{f.count}</span>}
                </button>
              ))}
            </div>
            <div className="qhead">{viewingResolved ? 'Resolved history' : filter === 'needs' ? 'Needs action' : 'Incoming'}</div>
            {loaded && displayed.length === 0 && (
              <div className="queue-empty">{viewingResolved ? 'No resolved cases yet.' : filter === 'all' ? 'No inquiries yet.' : 'Nothing in this view.'}</div>
            )}
            {displayed.map((r) => {
              const b = BRANDS[r.brand]; const sm = STATUS[worst(r.items)];
              return (
                <div key={r.id} className={'qitem' + (r.id === selected ? ' selected' : '') + (r.needsAction ? ' flagged' : '')} onClick={() => openInquiry(r.id)}>
                  <div className="qitem-top">
                    <span className="brand-tag" style={{ background: b.bg, color: b.color }}>{b.name}</span>
                    <span className="qtime">{r.time}</span>
                  </div>
                  <div className="qfrom">{r.from}</div>
                  <div className="qsummary">{r.summary}</div>
                  <div className="qbadges">
                    <span className="mini-pill" style={{ background: 'var(--surface-2)', color: 'var(--muted)' }}>{r.type}</span>
                    <span className="mini-pill" style={{ background: 'var(--surface-2)' }}><span className="mini-dot" style={{ background: sm.dot }} /><span style={{ color: sm.dot }}>{sm.label}</span></span>
                  </div>
                </div>
              );
            })}
          </section>

          <main className="detail">
            {!current ? <div className="empty">{loaded && rows.length === 0 ? 'No inquiries yet' : 'Select an inquiry'}</div> : (
              <>
                <button className="back-btn" onClick={() => setMobileDetail(false)}>&larr; Back to queue</button>
                <div className="detail-head">
                  <span className="brand-tag" style={{ background: BRANDS[current.brand].bg, color: BRANDS[current.brand].color, fontSize: 11, padding: '4px 10px' }}>{BRANDS[current.brand].name}</span>
                  <h1>{current.type}</h1>
                </div>
                <div className="detail-meta">
                  from <a href={'mailto:' + current.from}>{current.from}</a> &nbsp;&rarr;&nbsp; {current.to || 'unknown'}<br />
                  order {current.order || 'not matched'} &nbsp;·&nbsp; {current.placed && 'placed ' + current.placed + ' · '}{current.time} ago
                  {viewingResolved && current.resolvedAt && <><br />resolved {new Date(current.resolvedAt).toLocaleString()}</>}
                </div>
                <div className="card">
                  <div className="card-label">Issue <span className="issue-type">{current.type}</span></div>
                  <div className="issue-body">{current.summary}</div>
                  {current.original && (
                    <>
                      <div className="orig-label">Original email</div>
                      <div className="orig-body">{current.original}</div>
                    </>
                  )}
                </div>
                <div className="card">
                  <div className="card-label">Order status <span className="source-flag">SHOPIFY SOURCE OF TRUTH</span></div>
                  <div className="ledger-note">Status read per line item from Shopify. Vendor detail pulled only where an item is unshipped.</div>
                  {current.items.length === 0 && <div className="issue-body" style={{ color: 'var(--muted)' }}>No order matched to this inquiry.</div>}
                  {current.items.map((it, i) => {
                    const sm = STATUS[it.status] || STATUS.production;
                    return (
                      <div className="line-item" key={i}>
                        <div><div className="li-name">{it.name}</div><div className="li-sub">{[it.sku, it.tracking].filter(Boolean).join(' · ')}</div></div>
                        <div className="li-meta">
                          <span className={'fulfiller ' + it.fulfiller}>{FULFILLER[it.fulfiller] || it.fulfiller}</span>
                          <span className={'status-pill ' + sm.cls}><span className="mini-dot" style={{ background: sm.dot }} />{sm.label}</span>
                        </div>
                      </div>
                    );
                  })}
                  {current.needsAction && (
                    <div className="flag"><span className="ico">&#9873;</span><span>An item on this order needs action from your team (manual fulfillment unshipped, or a refund or replace decision). This is not a vendor delay.</span></div>
                  )}
                  {(current.shopifyUrl || vendorLinks.length > 0) && (
                    <div className="links-row">
                      {current.shopifyUrl && <a className="link-btn" href={current.shopifyUrl} target="_blank" rel="noreferrer">Open order in Shopify <span className="arw">&#8599;</span></a>}
                      {vendorLinks.map((v, i) => <a className="link-btn" key={i} href={v.vendorLink} target="_blank" rel="noreferrer">Find in {FULFILLER[v.fulfiller]} <span className="arw">&#8599;</span></a>)}
                    </div>
                  )}
                </div>
                <div className="card">
                  <div className="card-label">Proposed reply {drafts[current.id] != null && <span className="edited-tag">edited</span>}</div>
                  {editing ? (
                    <textarea
                      className="reply-edit"
                      value={drafts[current.id] != null ? drafts[current.id] : current.draft}
                      autoFocus
                      onChange={(e) => setDrafts((d) => ({ ...d, [current.id]: e.target.value }))}
                    />
                  ) : (
                    <div className="reply-box">{drafts[current.id] != null ? drafts[current.id] : current.draft}</div>
                  )}
                  <div className="reply-actions">
                    <button className={'btn btn-primary' + (copied ? ' copied' : '')} onClick={copyReply}>{copied ? 'Copied \u2713' : 'Copy reply'}</button>
                    {editing ? (
                      <button className="btn btn-ghost" onClick={() => setEditing(false)}>Done</button>
                    ) : (
                      <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
                    )}
                    {drafts[current.id] != null && !editing && (
                      <button className="btn btn-ghost" onClick={() => setDrafts((d) => { const n = { ...d }; delete n[current.id]; return n; })}>Reset</button>
                    )}
                    {viewingResolved
                      ? <button className="btn btn-ghost" onClick={() => reopenInquiry(current.id)}>Reopen</button>
                      : <button className="btn btn-ghost" onClick={() => resolveInquiry(current.id)}>Mark resolved</button>}
                    {current.confidence != null && <span className="confidence">draft confidence {current.confidence}</span>}
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      )}
      {tab === 'risk' && (
        <div className="risk-wrap">
          <div className="risk-head">Orders likely to become a problem &nbsp;·&nbsp; {risk.length} flagged</div>
          {loaded && risk.length === 0 && <div className="risk-empty">Nothing at risk right now. Run the scan to check your recent orders.</div>}
          {risk.map((r) => {
            const b = BRANDS[r.brand];
            return (
              <div key={r.id} className={'risk-card ' + r.severity}>
                <div className="risk-main">
                  <div className="risk-top">
                    <span className="brand-tag" style={{ background: b.bg, color: b.color }}>{b.name}</span>
                    <span className="risk-order">{r.order}</span>
                  </div>
                  <div className="risk-cust">{r.customer}</div>
                  {r.items && <div className="risk-items">{r.items}</div>}
                  <div className="risk-reasons">
                    {r.reasons.map((reason, i) => <span className="reason-pill" key={i}>{reason}</span>)}
                  </div>
                </div>
                <div className="risk-side">
                  <span className="risk-age">{r.age}d old</span>
                  {r.url && r.url !== '#' && <a className="link-btn" href={r.url} target="_blank" rel="noreferrer">Open <span className="arw">&#8599;</span></a>}
                  <button className="btn btn-ghost" onClick={() => dismissRisk(r)}>Clear</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab === 'builder' && <Builder />}
      {tab === 'mockups' && <Mockups />}
      {tab === 'settings' && <Settings />}

      {/* Thumb-reach navigation. Hidden above 680px, where the topbar tabs take over. */}
      <nav className="bottom-nav">
        {TABS.map((t) => (
          <button key={t.key} className={'bn-item' + (tab === t.key ? ' active' : '')}
            onClick={() => { setTab(t.key); setMobileDetail(false); }} aria-label={t.label}>
            <span className="bn-icon" aria-hidden="true">{t.icon}</span>
            <span className="bn-label">{t.short}</span>
            {badgeFor(t.key) > 0 && <span className="bn-badge">{badgeFor(t.key)}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}
