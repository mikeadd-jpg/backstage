'use client';
// Printful draft orders, shown with their print files so a human can look at each
// generated map before it is printed. Approving confirms the draft in Printful, which
// charges the account and starts production, so it asks first and states the cost.
// Nothing here edits or replaces a file; a bad render is fixed in Printful or at the
// generator, then reloaded here.
import { useState } from 'react';

function money(cost, currency) {
  if (cost == null) return '';
  const n = Number(cost);
  return (currency === 'USD' || !currency ? '$' : currency + ' ') + (isNaN(n) ? cost : n.toFixed(2));
}
function ago(iso) {
  if (!iso) return '';
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  return h < 24 ? h + 'h old' : Math.floor(h / 24) + 'd old';
}

export default function Approvals({ data, loading, reload, onApproved, brands }) {
  const [busy, setBusy] = useState({});     // order id -> true while confirming
  const [errors, setErrors] = useState({}); // order id -> message
  const [done, setDone] = useState([]);     // recently approved, for the confirmation line

  const drafts = data ? data.drafts : [];

  async function approve(d) {
    const ok = window.confirm(
      'Send Printful order ' + d.id + ' (' + d.recipient + ') to production?\n\n' +
      'Printful will charge ' + money(d.cost, d.currency) + ' and start printing. This cannot be undone here.'
    );
    if (!ok) return;
    setBusy((b) => ({ ...b, [d.id]: true }));
    setErrors((e) => { const n = { ...e }; delete n[d.id]; return n; });
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand: d.brand, orderId: d.id }),
      });
      const out = await res.json();
      if (!res.ok || out.error) throw new Error(out.error || 'Request failed');
      setDone((x) => [{ id: d.id, recipient: d.recipient, status: out.status }, ...x].slice(0, 5));
      onApproved(d.id);
    } catch (err) {
      setErrors((e) => ({ ...e, [d.id]: String(err.message || err) }));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[d.id]; return n; });
    }
  }

  return (
    <div className="risk-wrap">
      <div className="approve-headrow">
        <div className="risk-head" style={{ marginBottom: 0 }}>Printful drafts awaiting approval &nbsp;·&nbsp; {drafts.length}</div>
        <button className="btn btn-ghost" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Reload'}</button>
      </div>

      {data && !data.configured && <div className="risk-empty">No brand has a Printful store configured.</div>}
      {data && data.errors && data.errors.map((e, i) => <div className="approve-error" key={i}>{e}</div>)}
      {done.map((x) => (
        <div className="approve-done" key={x.id}>Sent order {x.id} ({x.recipient}) to production. Printful status: {x.status}.</div>
      ))}
      {!loading && data && data.configured && drafts.length === 0 && (
        <div className="risk-empty">No drafts waiting. Everything has been sent to production.</div>
      )}

      {/* A grid on wide screens: each card keeps its full-size print preview, since judging
          the print is the whole job here, but several fit side by side. */}
      <div className="approve-list">
      {drafts.map((d) => {
        const b = brands[d.brand] || brands.unknown;
        const fileProblem = d.items.some((it) => it.files.length === 0 || it.files.some((f) => f.status !== 'ok'));
        const stockProblem = d.items.some((it) => it.outOfStock || it.discontinued);
        return (
          <div key={d.id} className="approve-card">
            <div className="risk-top">
              <span className="brand-tag" style={{ background: b.bg, color: b.color }}>{b.name}</span>
              <span className="risk-order">Printful #{d.id}</span>
              <span className="risk-age">{ago(d.created)}</span>
            </div>
            <div className="risk-cust">{d.recipient}{d.country ? ' · ' + d.country : ''}</div>

            {d.items.map((it, i) => (
              <div className="approve-item" key={i}>
                <div className="approve-item-name">{it.quantity > 1 ? it.quantity + ' × ' : ''}{it.name}</div>
                <div className="approve-files">
                  {it.files.length === 0 && <div className="approve-warn">No print file attached to this item.</div>}
                  {it.files.map((f, j) => (
                    <figure className="approve-file" key={j}>
                      {f.preview
                        ? <a href={f.preview} target="_blank" rel="noreferrer" title="Open larger preview">
                            <img src={f.preview} alt={'Print file: ' + f.filename} loading="lazy" />
                          </a>
                        : <div className="approve-noimg">No preview</div>}
                      <figcaption>
                        <span className="approve-fname">{f.filename || 'print file'}</span>
                        <span>{f.type !== 'default' ? f.type + ' · ' : ''}{f.width && f.height ? f.width + '×' + f.height + 'px' : ''}</span>
                        {f.status !== 'ok' && <span className="approve-warn">File status: {f.status}</span>}
                      </figcaption>
                    </figure>
                  ))}
                  {it.mockup && (
                    <figure className="approve-file approve-mock">
                      <a href={it.mockup} target="_blank" rel="noreferrer"><img src={it.mockup} alt="Printful mockup" loading="lazy" /></a>
                      <figcaption><span>Printful mockup</span></figcaption>
                    </figure>
                  )}
                </div>
                {(it.outOfStock || it.discontinued) && (
                  <div className="approve-warn">{it.discontinued ? 'Discontinued' : 'Out of stock'} at Printful.</div>
                )}
              </div>
            ))}

            {d.error && <div className="approve-warn">Printful: {d.error}</div>}
            {fileProblem && <div className="approve-warn">A print file is missing or not processed. Check it in Printful before approving.</div>}
            {stockProblem && <div className="approve-warn">An item cannot be produced as is. Printful will likely reject the confirm.</div>}
            {errors[d.id] && <div className="approve-error">{errors[d.id]}</div>}

            <div className="approve-actions">
              <button className="btn btn-primary" onClick={() => approve(d)} disabled={!!busy[d.id]}>
                {busy[d.id] ? 'Sending…' : 'Approve and send to production' + (d.cost ? ' · ' + money(d.cost, d.currency) : '')}
              </button>
              <a className="link-btn" href={d.dashboardUrl} target="_blank" rel="noreferrer">Open in Printful <span className="arw">&#8599;</span></a>
              {d.shopifyUrl && <a className="link-btn" href={d.shopifyUrl} target="_blank" rel="noreferrer">Open in Shopify <span className="arw">&#8599;</span></a>}
            </div>
          </div>
        );
      })}
      </div>
    </div>
  );
}
