'use client';
// Home. Two halves:
//   Needs you now - live items from lib/focus.js (customers waiting, risky orders, prints
//                   to approve). Fast, rule-based, always current.
//   Briefing      - Claude's read of the business from a digest of profit, ads, traffic
//                   and email (lib/briefing.js): the good, the bad, and what to do. Written
//                   once a day per role, cached, and regenerable.
// Roles with no Insights areas see only the first half.
import { useEffect, useState } from 'react';

const IMPACT_LABEL = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
const TAB_LABEL = { profit: 'Profit', attribution: 'Attribution', email: 'Email', traffic: 'Traffic', inbox: 'Inbox', risk: 'At risk', approvals: 'Approvals' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function useJson(url, enabled = true) {
  const [state, setState] = useState({ loading: enabled, data: null, error: '' });
  const [nonce, setNonce] = useState(0);
  const [target, setTarget] = useState(url);
  useEffect(() => {
    if (!enabled) { setState({ loading: false, data: null, error: '' }); return undefined; }
    let dead = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    fetch(target).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (d.error) throw new Error(d.error);
      setState({ loading: false, data: d, error: '' });
    }).catch((e) => { if (!dead) setState((s) => ({ ...s, loading: false, error: String(e.message || e) })); });
    return () => { dead = true; };
  }, [target, nonce, enabled]);
  return [state, (u) => { setTarget(u); setNonce((n) => n + 1); }];
}

function NowItem({ item, go }) {
  return (
    <li className={'hm-item tone-' + item.tone}>
      <div className="hm-body">
        <div className="hm-title">{item.title}</div>
        <div className="hm-detail">{item.detail}</div>
      </div>
      <button className="hm-go" onClick={() => go(item.tab)}>{item.action || 'Open'} →</button>
    </li>
  );
}

function Point({ p, kind, go }) {
  return (
    <li className={'br-point ' + kind}>
      <div className="br-point-title">{p.title}</div>
      <div className="hm-detail">{p.detail}</div>
      {p.tab && <button className="br-link" onClick={() => go(p.tab)}>See {TAB_LABEL[p.tab]} →</button>}
    </li>
  );
}

function Briefing({ b, go, regenerate, busy }) {
  const written = b.writtenAt ? new Date(b.writtenAt) : null;
  const canRegen = !written || Date.now() - written.getTime() > 15 * 60 * 1000;
  return (
    <section className="br">
      <div className="br-headline">{b.headline}</div>

      <div className="br-cols">
        <div>
          <div className="pf-label pf-section-head br-good-head">Going well</div>
          <ul className="br-points">{b.good.map((p, i) => <Point key={i} p={p} kind="good" go={go} />)}</ul>
        </div>
        <div>
          <div className="pf-label pf-section-head br-bad-head">Needs work</div>
          <ul className="br-points">{b.bad.map((p, i) => <Point key={i} p={p} kind="bad" go={go} />)}</ul>
        </div>
      </div>

      <div className="pf-label pf-section-head">What to do</div>
      <ol className="hm-list br-actions">
        {b.actions.map((a, i) => (
          <li className={'hm-item impact-' + a.impact} key={i}>
            <span className="hm-n">{i + 1}</span>
            <div className="hm-body">
              <span className="hm-tone">{IMPACT_LABEL[a.impact]}</span>
              <div className="hm-title">{a.title}</div>
              <div className="hm-detail">{a.why}</div>
            </div>
            {a.tab && <button className="hm-go" onClick={() => go(a.tab)}>{TAB_LABEL[a.tab]} →</button>}
          </li>
        ))}
      </ol>

      <div className="pf-sub em-foot hm-foot">
        Written by Claude{written ? ' at ' + written.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''} from
        your numbers only: last 7 and 30 days (today so far) against the periods before. Check anything surprising on the
        tab it links to.
        {b.unavailable && b.unavailable.length > 0 && <> Not available this time: {b.unavailable.join('; ')}.</>}
        {' '}
        <button className="br-link inline" disabled={busy || !canRegen} onClick={regenerate}
          title={canRegen ? 'Write it again from fresh data' : 'Can be rewritten 15 minutes after the last one'}>
          {busy ? 'Rewriting…' : 'Rewrite from fresh data'}
        </button>
      </div>
    </section>
  );
}

export default function Home({ me, go }) {
  const wantsBriefing = !!(me && me.areas.some((a) => ['profit', 'attribution', 'email', 'traffic'].includes(a)));
  const [ops] = useJson('/api/focus?part=ops');
  const [brief, reload] = useJson('/api/briefing', wantsBriefing);
  const name = me && me.name ? me.name.split(' ')[0] : '';
  const now = (ops.data && ops.data.items) || [];
  const b = brief.data && brief.data.briefing;

  return (
    <div className="pane hm-pane">
      <div className="pane-head">{greeting()}{name ? ', ' + name : ''}</div>
      <div className="pane-sub">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>

      {ops.error && <div className="approve-error">{ops.error}</div>}
      {now.length > 0 && (
        <>
          <div className="pf-label pf-section-head">Needs you now</div>
          <ul className="hm-list hm-now">{[...now].sort((x, y) => y.score - x.score).map((it) => <NowItem key={it.id} item={it} go={go} />)}</ul>
        </>
      )}
      {!ops.loading && !now.length && !wantsBriefing && (
        <div className="hm-clear"><b>Nothing needs you right now.</b><span>No one waiting, nothing at risk, nothing to approve.</span></div>
      )}

      {wantsBriefing && (
        <>
          <div className="pf-label pf-section-head">Today's briefing</div>
          {brief.error && <div className="approve-error">The briefing could not be written: {brief.error}</div>}
          {!b && brief.loading && (
            <div className="hm-loading">
              Reading profit, ads, traffic and email, then writing today's briefing…
              <span className="hm-loading-sub">The first one each day takes up to a minute or two. After that it opens instantly.</span>
            </div>
          )}
          {b && <Briefing b={b} go={go} busy={brief.loading} regenerate={() => reload('/api/briefing?force=1&t=' + Date.now())} />}
        </>
      )}
    </div>
  );
}
