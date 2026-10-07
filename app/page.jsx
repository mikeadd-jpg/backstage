'use client';
import { useEffect, useState } from 'react';
import Approvals from './Approvals';
import Attribution from './Attribution';
import AtRisk from './AtRisk';
import Inbox from './Inbox';
import { BRANDS } from './ui';
import Builder from './Builder';
import Mockups from './Mockups';
import Profit from './Profit';
import Settings from './Settings';
import Shell, { allowedDestinations } from './Shell';
import Users from './Users';

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
  const [tab, setTab] = useState(null);   // set once we know the role; mirrors location.hash
  const [rows, setRows] = useState([]);
  const [risk, setRisk] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [me, setMe] = useState(null);
  const [resolvedRows, setResolvedRows] = useState([]);
  const [resolvedLoaded, setResolvedLoaded] = useState(false);
  const [approvals, setApprovals] = useState(null); // { drafts, errors, configured }
  const [approvalsLoading, setApprovalsLoading] = useState(false);

  function loadOpen() {
    return fetch('/api/inquiries').then((r) => r.json()).then((d) => {
      const n = (d.inquiries || []).map(normalize);
      setRows(n);
    }).catch(() => {});
  }
  function loadResolved() {
    return fetch('/api/inquiries?status=resolved').then((r) => r.json()).then((d) => {
      setResolvedRows((d.inquiries || []).map(normalize));
      setResolvedLoaded(true);
    }).catch(() => {});
  }
  function loadApprovals() {
    setApprovalsLoading(true);
    return fetch('/api/approvals').then((r) => r.json()).then(setApprovals)
      .catch(() => {}).finally(() => setApprovalsLoading(false));
  }
  // Role first, then only the data this person's screens use: asking for the rest would
  // just collect 403s. A 401 means they were removed since signing in.
  useEffect(() => {
    fetch('/api/me').then((r) => {
      if (r.status === 401) { window.location.href = '/login'; return null; }
      return r.json();
    }).then((d) => {
      if (!d || !d.user) return;
      const u = d.user;
      setMe(u);
      const can = (a) => u.areas.includes(a);
      if (can('approvals')) loadApprovals();
      Promise.all([
        can('inbox') ? loadOpen() : null,
        can('risk') ? fetch('/api/risk-orders').then((r) => r.json()).then((x) => {
          setRisk((x.riskOrders || []).map(normalizeRisk));
        }).catch(() => {}) : null,
      ]).finally(() => setLoaded(true));
    }).catch(() => {});
  }, []);

  // The open screen lives in the URL hash, so refresh, links and the phone's back button
  // all work. Anything the role doesn't include falls back to the first screen it does.
  const allowed = allowedDestinations(me);
  useEffect(() => {
    if (!me) return;
    const pick = () => {
      let k = window.location.hash.slice(1);
      if (k === 'builder') k = 'products';  // old name, kept so saved links still land
      setTab(allowed.includes(k) ? k : allowed[0] || null);
    };
    pick();
    window.addEventListener('hashchange', pick);
    return () => window.removeEventListener('hashchange', pick);
  }, [me]);  // allowed derives from me, so me is the only real dependency
  function go(k) {
    if (window.location.hash === '#' + k) setTab(k);
    else window.location.hash = k;  // the hashchange listener does the rest
  }

  const actionCount = rows.filter((r) => r.needsAction).length;
  const riskHigh = risk.filter((r) => r.severity === 'high').length;

  function dismissRisk(r) {
    setRisk((prev) => prev.filter((x) => x.id !== r.id));
    fetch('/api/risk-dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: r.id, ruleKey: r.ruleKey }),
    }).catch(() => {});
  }
  function resolveInquiry(id) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setResolvedLoaded(false); // history will refetch next time it is opened
    fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }
  function reopenInquiry(id) {
    setResolvedRows((prev) => prev.filter((r) => r.id !== id));
    fetch('/api/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'reopen' }),
    }).then(() => loadOpen()).catch(() => {});
  }

  const draftCount = approvals ? approvals.drafts.length : 0;
  const badges = { inbox: actionCount, risk: riskHigh, approvals: draftCount };

  return (
    <Shell me={me} current={tab} go={go} badges={badges}>
      {!me && <div className="risk-empty">Loading…</div>}
      {me && !tab && <div className="risk-empty">Your role doesn't include any screens yet. Ask an admin.</div>}
      {tab === 'inbox' && (
        <Inbox rows={rows} resolvedRows={resolvedRows} resolvedLoaded={resolvedLoaded} loadResolved={loadResolved}
          loaded={loaded} onResolve={resolveInquiry} onReopen={reopenInquiry} />
      )}
      {tab === 'risk' && <AtRisk risk={risk} loaded={loaded} onClear={dismissRisk} />}
      {tab === 'approvals' && (
        <Approvals data={approvals} loading={approvalsLoading} reload={loadApprovals} brands={BRANDS}
          onApproved={(id) => setApprovals((a) => ({ ...a, drafts: a.drafts.filter((d) => d.id !== id) }))} />
      )}
      {tab === 'products' && <Builder />}
      {tab === 'mockups' && <Mockups />}
      {tab === 'profit' && <Profit />}
      {tab === 'attribution' && <Attribution />}
      {tab === 'settings' && <Settings />}
      {tab === 'users' && <Users />}
    </Shell>
  );
}
