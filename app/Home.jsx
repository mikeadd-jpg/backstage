'use client';
// Home: the five things most worth your attention right now, ranked by the rules in
// lib/focus.js across every screen this person's role can open. Live items (customers
// waiting, risky orders, prints to approve) arrive first; the 7-day profit, ads, email and
// traffic checks follow and slot into the ranking when they land.
import { useEffect, useState } from 'react';

const TOP = 5;
const TONE_LABEL = { urgent: 'Now', act: 'This week', watch: 'Watch', good: 'Opportunity' };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function usePart(part) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => {
    let dead = false;
    fetch('/api/focus?part=' + part).then((r) => r.json()).then((d) => {
      if (dead) return;
      if (d.error) throw new Error(d.error);
      setState({ loading: false, data: d, error: '' });
    }).catch((e) => { if (!dead) setState({ loading: false, data: null, error: String(e.message || e) }); });
    return () => { dead = true; };
  }, [part]);
  return state;
}

function Item({ item, n, go }) {
  return (
    <li className={'hm-item tone-' + item.tone}>
      {n != null && <span className="hm-n">{n}</span>}
      <div className="hm-body">
        <div className="hm-top">
          <span className="hm-tone">{TONE_LABEL[item.tone] || ''}</span>
        </div>
        <div className="hm-title">{item.title}</div>
        <div className="hm-detail">{item.detail}</div>
      </div>
      <button className="hm-go" onClick={() => go(item.tab)}>{item.action || 'Open'} →</button>
    </li>
  );
}

export default function Home({ me, go }) {
  const ops = usePart('ops');
  const insights = usePart('insights');
  const [showMore, setShowMore] = useState(false);
  const wantsInsights = me && me.areas.some((a) => ['profit', 'attribution', 'email', 'traffic'].includes(a));

  const items = [...((ops.data && ops.data.items) || []), ...((insights.data && insights.data.items) || [])]
    .sort((a, b) => b.score - a.score);
  const top = items.slice(0, TOP);
  const rest = items.slice(TOP);
  const skipped = [...((ops.data && ops.data.skipped) || []), ...((insights.data && insights.data.skipped) || [])];
  const stillLoading = ops.loading || (wantsInsights && insights.loading);
  const name = me && me.name ? me.name.split(' ')[0] : '';
  const w = insights.data && insights.data.window;

  return (
    <div className="pane hm-pane">
      <div className="pane-head">{greeting()}{name ? ', ' + name : ''}</div>
      <div className="pane-sub">
        {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}. The {TOP} things most worth your
        attention, ranked across everything you can see.
      </div>

      {ops.error && <div className="approve-error">{ops.error}</div>}
      {wantsInsights && insights.error && <div className="approve-error">Insights: {insights.error}</div>}

      {top.length > 0 && (
        <ol className="hm-list">
          {top.map((it, i) => <Item key={it.id} item={it} n={i + 1} go={go} />)}
        </ol>
      )}
      {!stillLoading && !top.length && (
        <div className="hm-clear">
          <b>Nothing needs you right now.</b>
          <span>No one waiting, nothing at risk, and no week-on-week drop worth flagging.</span>
        </div>
      )}
      {stillLoading && (
        <div className="hm-loading">
          {ops.loading ? 'Checking the inbox, orders and approvals…' : 'Checking profit, ads, email and traffic against last week…'}
          <span className="hm-loading-sub">The full ranking settles once every source has answered; the order can still change.</span>
        </div>
      )}

      {rest.length > 0 && !stillLoading && (
        <>
          <button className="pf-chip small em-more" onClick={() => setShowMore((v) => !v)}>
            {showMore ? 'Hide' : 'Also worth a look:'} {rest.length} more
          </button>
          {showMore && <ul className="hm-list hm-more">{rest.map((it) => <Item key={it.id} item={it} go={go} />)}</ul>}
        </>
      )}

      {!stillLoading && (
        <div className="pf-sub em-foot hm-foot">
          {w ? `Week-on-week checks compare ${w.cur.from} to ${w.cur.to} (today so far) with the 7 days before. ` : ''}
          Ranked by fixed rules: money being lost first, then people waiting and things that broke, then real declines,
          then watch items and opportunities.
          {skipped.length > 0 && <> Not checked this time: {skipped.join('; ')}.</>}
        </div>
      )}
    </div>
  );
}
