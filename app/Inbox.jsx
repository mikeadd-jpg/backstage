'use client';
// The support inbox: a dense, searchable queue beside the selected message. On phones the
// two become separate screens with a back button.
//
// Data and server writes stay in app/page.jsx (it also feeds the nav badges); this file
// owns only how the queue is filtered, searched and read. Filters live in the queue
// header rather than a separate column, so the message itself gets the width.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BRANDS, RAIL_BRANDS, STATUS, FULFILLER, worst, matches } from './ui';

const VIEWS = [
  { key: 'open', label: 'Open' },
  { key: 'needs', label: 'Needs action' },
  { key: 'resolved', label: 'Resolved' },
];

export default function Inbox({ rows, resolvedRows, resolvedLoaded, loadResolved, loaded, onResolve, onReopen }) {
  const [view, setView] = useState('open');
  const [brand, setBrand] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState({});   // per-inquiry edited reply text, kept while the tab is open
  const [copied, setCopied] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  // The live Gmail conversation for the open message, our own replies included, plus who a
  // reply would go to and from: { id, loading, messages, plan, cantSend, error }.
  const [thread, setThread] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState('');
  const listRef = useRef(null);

  function pickView(v) {
    setView(v); setSelected(null);
    if (v === 'resolved' && !resolvedLoaded) loadResolved();
  }

  const source = view === 'resolved' ? resolvedRows : rows;
  const shown = useMemo(() => source.filter((r) =>
    (view !== 'needs' || r.needsAction) &&
    (brand === 'all' || r.brand === brand) &&
    matches(query, r.from, r.order, r.summary, r.type, r.original),
  ), [source, view, brand, query]);
  const current = shown.find((r) => r.id === selected) || shown[0] || null;

  // Reset the per-message view state whenever the message changes.
  useEffect(() => { setEditing(false); setShowOriginal(false); setCopied(false); setSendMsg(''); }, [current && current.id]);

  // Load the conversation whenever the open message changes. A late answer for a message
  // no longer open is dropped.
  useEffect(() => {
    if (!current) { setThread(null); return; }
    const id = current.id;
    setThread({ id, loading: true });
    fetch('/api/inquiries/thread?id=' + encodeURIComponent(id)).then((r) => r.json())
      .then((d) => setThread((t) => (t && t.id === id ? { id, ...d, loading: false } : t)))
      .catch(() => setThread((t) => (t && t.id === id ? { id, loading: false, error: 'Could not load the conversation.' } : t)));
  }, [current && current.id]);

  const counts = {
    open: rows.length,
    needs: rows.filter((r) => r.needsAction).length,
    resolved: resolvedLoaded ? resolvedRows.length : null,
  };
  const brandCount = (b) => source.filter((r) => r.brand === b && (view !== 'needs' || r.needsAction)).length;

  function open(id) { setSelected(id); setMobileDetail(true); }

  // Arrow keys or j/k step through the queue, unless you're typing.
  useEffect(() => {
    function onKey(e) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = (e.key === 'ArrowDown' || e.key === 'j') ? 1 : (e.key === 'ArrowUp' || e.key === 'k') ? -1 : 0;
      if (!step || !shown.length) return;
      e.preventDefault();
      const i = Math.max(0, shown.findIndex((r) => current && r.id === current.id));
      const next = shown[Math.min(shown.length - 1, Math.max(0, i + step))];
      setSelected(next.id);
      const el = listRef.current && listRef.current.querySelector('[data-id="' + next.id + '"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, current]);

  const replyText = current ? (drafts[current.id] != null ? drafts[current.id] : current.draft) : '';
  function copyReply() {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(replyText).then(done).catch(done);
    else done();
  }
  function resolve() { onResolve(current.id); setSelected(null); setMobileDetail(false); }

  const plan = thread && thread.id === (current && current.id) ? thread.plan : null;
  // Sending emails a customer, so it always asks first and says exactly from and to whom.
  async function sendReply() {
    if (!plan || sending) return;
    const ok = window.confirm('Send this reply?\n\nFrom: ' + (plan.fromName ? plan.fromName + ' <' + plan.from + '>' : plan.from) +
      '\nTo: ' + plan.to + '\nSubject: ' + plan.subject + (plan.hasSignature ? '\n\nThe ' + plan.from + ' signature is added.' : ''));
    if (!ok) return;
    setSending(true); setSendMsg('');
    const id = current.id;
    const d = await fetch('/api/inquiries/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: replyText }),
    }).then((r) => r.json()).catch(() => ({ error: 'The request failed. Check Gmail before sending again.' }));
    setSending(false);
    if (d.error) { setSendMsg(d.error); return; }
    setDrafts((x) => { const n = { ...x }; delete n[id]; return n; });
    // The server already marked it resolved; this moves it out of the open list here too.
    onResolve(id); setSelected(null); setMobileDetail(false);
  }
  function reopen() { onReopen(current.id); setSelected(null); setMobileDetail(false); }

  const vendorLinks = current ? ['printify', 'gelato', 'printful']
    .map((f) => current.items.find((i) => i.fulfiller === f && i.vendorLink)).filter(Boolean) : [];
  const isResolvedView = view === 'resolved';

  return (
    <div className={'ibx ' + (mobileDetail ? 'show-detail' : 'show-queue')}>
      <section className="ibx-queue" aria-label="Inquiries">
        <div className="ibx-tools">
          <input className="input ibx-search" type="search" placeholder="Search email, order, summary" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search inquiries" />
          <div className="ibx-views" role="tablist" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.key} role="tab" aria-selected={view === v.key} className={'ibx-view' + (view === v.key ? ' on' : '')}
                onClick={() => pickView(v.key)}>
                {v.label}{counts[v.key] != null && <span className={'ibx-n' + (v.key === 'needs' && counts.needs ? ' warn' : '')}>{counts[v.key]}</span>}
              </button>
            ))}
          </div>
          <div className="ibx-brands" role="group" aria-label="Brand">
            <button className={'ibx-brand' + (brand === 'all' ? ' on' : '')} onClick={() => setBrand('all')}>All</button>
            {RAIL_BRANDS.map((b) => (
              <button key={b} className={'ibx-brand' + (brand === b ? ' on' : '')} title={BRANDS[b].name}
                onClick={() => setBrand(brand === b ? 'all' : b)}>
                <i style={{ background: BRANDS[b].color }} />{BRANDS[b].name}<span>{brandCount(b)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ibx-list" ref={listRef}>
          {loaded && shown.length === 0 && (
            <div className="queue-empty">
              {query ? 'Nothing matches "' + query + '".' : isResolvedView ? 'No resolved cases yet.' : view === 'needs' ? 'Nothing needs action.' : 'Inbox zero.'}
            </div>
          )}
          {shown.map((r) => {
            const b = BRANDS[r.brand]; const sm = STATUS[worst(r.items)];
            const on = current && r.id === current.id;
            return (
              <button key={r.id} data-id={r.id} className={'ibx-row' + (on ? ' on' : '')} onClick={() => open(r.id)}
                aria-current={on ? 'true' : undefined} style={{ '--brand': b.color }}>
                <span className="ibx-row-top">
                  <span className="ibx-from">{r.from}</span>
                  {r.needsAction && <span className="ibx-flag" title="Needs action from your team">Action</span>}
                  <span className="ibx-time">{r.time}</span>
                </span>
                <span className="ibx-sum">{r.summary || r.type}</span>
                <span className="ibx-meta">
                  <span className="ibx-brandtag" style={{ color: b.color }}>{b.short}</span>
                  <span>{r.type}</span>
                  <span className="ibx-status"><i style={{ background: sm.dot }} />{sm.label}</span>
                  {r.order && <span className="ibx-order">{r.order}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <main className="ibx-detail">
        {!current ? (
          <div className="empty">{loaded && rows.length === 0 ? 'No inquiries yet' : 'Select an inquiry'}</div>
        ) : (
          <>
            <div className="ibx-dhead">
              <button className="back-btn" onClick={() => setMobileDetail(false)}>&larr; Back</button>
              <div className="ibx-dtitle">
                <span className="brand-tag" style={{ background: BRANDS[current.brand].bg, color: BRANDS[current.brand].color }}>{BRANDS[current.brand].name}</span>
                <h1>{current.type}</h1>
              </div>
              <div className="ibx-dmeta">
                <a href={'mailto:' + current.from}>{current.from}</a>
                <span>to {current.to || 'unknown'}</span>
                <span>order {current.order || 'not matched'}</span>
                {current.placed && <span>placed {current.placed}</span>}
                <span>{current.time} ago</span>
                {isResolvedView && current.resolvedAt && <span>resolved {new Date(current.resolvedAt).toLocaleString()}</span>}
              </div>
              {/* The two things an agent does with every message, kept at the top. */}
              <div className="ibx-dactions">
                {!isResolvedView && plan && (
                  <button className="btn btn-primary" onClick={sendReply} disabled={sending || !replyText.trim()}
                    title={'Sends from ' + plan.from + ' to ' + plan.to}>
                    {sending ? 'Sending…' : 'Send reply'}
                  </button>
                )}
                <button className={'btn ' + (plan && !isResolvedView ? 'btn-ghost' : 'btn-primary') + (copied ? ' copied' : '')} onClick={copyReply}>{copied ? 'Copied ✓' : 'Copy reply'}</button>
                {isResolvedView
                  ? <button className="btn btn-ghost" onClick={reopen}>Reopen</button>
                  : <button className="btn btn-ghost" onClick={resolve}>Mark resolved</button>}
              </div>
            </div>

            <div className="ibx-dgrid">
              <div className="ibx-dmain">
                <div className="card">
                  <div className="card-label">Issue</div>
                  <div className="issue-body">{current.summary}</div>
                  {current.original && (
                    <>
                      <div className={'orig-body' + (showOriginal ? '' : ' clamped')}>{current.original}</div>
                      <button className="ibx-more" onClick={() => setShowOriginal((s) => !s)}>
                        {showOriginal ? 'Show less' : 'Show full email'}
                      </button>
                    </>
                  )}
                </div>

                <div className="card">
                  <div className="card-label">Proposed reply {drafts[current.id] != null && <span className="edited-tag">edited</span>}</div>
                  {editing ? (
                    <textarea className="reply-edit" value={replyText} autoFocus
                      onChange={(e) => setDrafts((d) => ({ ...d, [current.id]: e.target.value }))} />
                  ) : (
                    <div className="reply-box">{replyText}</div>
                  )}
                  <div className="reply-actions">
                    {/* Copy reply lives in the header above, so it is one click without scrolling. */}
                    {editing
                      ? <button className="btn btn-ghost" onClick={() => setEditing(false)}>Done</button>
                      : <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>}
                    {drafts[current.id] != null && !editing && (
                      <button className="btn btn-ghost" onClick={() => setDrafts((d) => { const n = { ...d }; delete n[current.id]; return n; })}>Reset</button>
                    )}
                    {current.confidence != null && <span className="confidence">draft confidence {current.confidence}</span>}
                  </div>
                  {!isResolvedView && thread && thread.id === current.id && !thread.loading && (
                    <div className="li-sub" style={{ marginTop: 8 }}>
                      {plan
                        ? 'Send goes from ' + plan.from + ' to ' + plan.to + (plan.hasSignature ? ', with its signature added.' : '.')
                        : thread.cantSend || thread.error || ''}
                    </div>
                  )}
                  {sendMsg && <div className="ledger-note" style={{ marginTop: 8 }}>{sendMsg}</div>}
                </div>

                <div className="card">
                  <div className="card-label">Conversation <span className="source-flag">GMAIL</span></div>
                  {!thread || thread.id !== current.id || thread.loading ? (
                    <div className="li-sub">Loading the conversation…</div>
                  ) : thread.error ? (
                    <div className="li-sub">{thread.error}</div>
                  ) : !thread.messages || thread.messages.length === 0 ? (
                    <div className="li-sub">{thread.cantSend || 'No messages found in the mailbox.'}</div>
                  ) : thread.messages.map((m) => (
                    <div key={m.id} className={'ibx-msg' + (m.sent ? ' sent' : '')}>
                      <div className="ibx-msg-head">
                        <span className="ibx-msg-from">{m.sent ? 'You' : m.from}</span>
                        {m.sent && <span className="ibx-msg-tag">sent</span>}
                        <span className="ibx-msg-time">{new Date(m.date).toLocaleString()}</span>
                      </div>
                      <div className="ibx-msg-body">{m.body}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="ibx-dside">
                <div className="card">
                  <div className="card-label">Order status <span className="source-flag">SHOPIFY</span></div>
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
                      {current.shopifyUrl && <a className="link-btn" href={current.shopifyUrl} target="_blank" rel="noreferrer">Shopify <span className="arw">&#8599;</span></a>}
                      {vendorLinks.map((v, i) => <a className="link-btn" key={i} href={v.vendorLink} target="_blank" rel="noreferrer">{FULFILLER[v.fulfiller]} <span className="arw">&#8599;</span></a>)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
