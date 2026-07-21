'use client';
import { useEffect, useMemo, useState } from 'react';

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
const FULFILLER = { you: 'Fulfilled by You', printify: 'Printify', gelato: 'Gelato' };

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
    needsAction: r.needs_action, draft: r.draft_reply || '',
    confidence: typeof r.confidence === 'number' ? r.confidence.toFixed(2) : r.confidence,
  };
}
function normalizeRisk(r) {
  return {
    id: r.order_id, brand: r.brand in BRANDS ? r.brand : 'unknown',
    order: r.order_number, customer: r.customer_name || r.customer_email || 'Unknown customer',
    reasons: r.reasons || [], severity: r.severity || 'medium',
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

  useEffect(() => {
    Promise.all([
      fetch('/api/inquiries').then((r) => r.json()).then((d) => {
        const n = (d.inquiries || []).map(normalize);
        setRows(n);
        if (n.length) setSelected(n[0].id);
      }).catch(() => {}),
      fetch('/api/risk-orders').then((r) => r.json()).then((d) => {
        setRisk((d.riskOrders || []).map(normalizeRisk));
      }).catch(() => {}),
    ]).finally(() => setLoaded(true));
  }, []);

  const current = useMemo(() => rows.find((r) => r.id === selected), [rows, selected]);
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
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== id);
      setSelected(next.length ? next[0].id : null);
      return next;
    });
    setMobileDetail(false);
    fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }

  const vendorLinks = current ? [
    current.items.find((i) => i.fulfiller === 'printify' && i.vendorLink),
    current.items.find((i) => i.fulfiller === 'gelato' && i.vendorLink),
  ].filter(Boolean) : [];

  return (
    <div className="app">
      <div className="topbar">
        <div className="wordmark">Backstage<small>SUPPORT TRIAGE</small></div>
        <div className="tabs" style={{ marginLeft: 8 }}>
          <button className={'tab' + (tab === 'inbox' ? ' active' : '')} onClick={() => setTab('inbox')}>
            Inbox {actionCount > 0 && <span className="badge">{actionCount}</span>}
          </button>
          <button className={'tab' + (tab === 'risk' ? ' active' : '')} onClick={() => setTab('risk')}>
            At risk {riskHigh > 0 && <span className="badge">{riskHigh}</span>}
          </button>
        </div>
        <div className="spacer" />
        <div className="avatar">M</div>
      </div>

      {tab === 'inbox' ? (
        <div className={'shell ' + (mobileDetail ? 'show-detail' : 'show-queue')}>
          <aside className="rail">
            <div className="eyebrow">Brands</div>
            <div className="filter active"><span className="dot" style={{ background: 'var(--action)' }} />All inboxes <span className="n">{rows.length}</span></div>
            {RAIL_BRANDS.map((b) => (
              <div className="filter" key={b}><span className="dot" style={{ background: BRANDS[b].color }} />{BRANDS[b].name} <span className="n">{counts[b] || 0}</span></div>
            ))}
            <div className="eyebrow" style={{ marginTop: 22 }}>View</div>
            <div className="filter"><span className="dot" style={{ background: 'var(--red)' }} />Needs action <span className="n">{actionCount}</span></div>
          </aside>

          <section className="queue">
            <div className="qhead">Incoming</div>
            {loaded && rows.length === 0 && (
              <div className="queue-empty">No inquiries yet.<br />Run the ingest to pull mail from the shared inbox.</div>
            )}
            {rows.map((r) => {
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
                    <button className="btn btn-ghost" onClick={() => resolveInquiry(current.id)}>Mark resolved</button>
                    {current.confidence != null && <span className="confidence">draft confidence {current.confidence}</span>}
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      ) : (
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
    </div>
  );
}
