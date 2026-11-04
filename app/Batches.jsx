'use client';
// Inspiration batches in progress (lib/recreate.js), shown at the top of Inspiration and
// Drafts: each picked ad's step, its mockups so far and a Stop button. It polls only while
// a batch is running; the batch itself runs on the server, so closing the page is fine.
import { useEffect, useRef, useState } from 'react';
import { BRANDS } from './ui';

const STAGES = {
  analyze: 'Reading the ad', products: 'Choosing products', mockups: 'Making mockups', plan: 'Planning the ad',
  render: 'Rendering', done: 'Done', failed: 'Failed',
};

function itemText(it) {
  if (it.stage === 'mockups') {
    const made = it.mockups.filter((m) => m.draftId).length;
    return 'Making mockups ' + made + ' of ' + it.mockups.length;
  }
  if (it.stage === 'done') return 'Done: ' + (it.make === 'video' ? 'video ad' : 'image ad') + ' in Drafts';
  if (it.stage === 'failed') return 'Failed: ' + (it.error || 'unknown error');
  return STAGES[it.stage] || it.stage;
}

export default function Batches({ refresh = 0, go, onSettled }) {
  const [batches, setBatches] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState({});
  const running = (batches || []).some((b) => b.status === 'running');
  const wasRunning = useRef(false);

  async function load() {
    try {
      const res = await fetch('/api/recreate', { cache: 'no-store' });
      if (res.status === 403 || res.status === 404) return setHidden(true);
      const d = await res.json();
      if (res.ok) setBatches(d.batches || []);
    } catch { /* keep what is shown */ }
  }
  useEffect(() => { load(); }, [refresh]);
  // Each new mockup or finished ad is a new draft, so the page beneath reloads as they land.
  const made = (batches || []).map((b) => b.id + ':' + b.items.map((it) => it.mockups.filter((m) => m.draftId).length + it.stage).join(',')).join('|');
  const lastMade = useRef(null);
  useEffect(() => {
    if (lastMade.current !== null && lastMade.current !== made && onSettled) onSettled();
    lastMade.current = made;
  }, [made]);
  useEffect(() => {
    wasRunning.current = running;
    if (!running) return undefined;
    const t = setInterval(() => { if (!document.hidden) load(); }, 6000);
    return () => clearInterval(t);
  }, [running]);

  async function stop(b) {
    if (!window.confirm('Stop this batch? What it has made stays in Drafts.')) return;
    await fetch('/api/recreate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', id: b.id }) });
    load();
  }

  if (hidden || !batches || !batches.length) return null;
  // Running batches, plus the latest finished one so its result is easy to find.
  const shown = [...batches.filter((b) => b.status === 'running'), ...batches.filter((b) => b.status !== 'running').slice(0, 1)];
  return (
    <div className="card rc-batches">
      {shown.map((b) => {
        const done = b.items.filter((it) => it.stage === 'done').length;
        const failed = b.items.filter((it) => it.stage === 'failed').length;
        const isOpen = open[b.id] !== undefined ? open[b.id] : b.status === 'running';
        return (
          <div key={b.id} className="rc-batch">
            <div className="rc-head">
              <button type="button" className="rc-title" onClick={() => setOpen((o) => ({ ...o, [b.id]: !isOpen }))}>
                {b.status === 'running' ? <span className="rc-spin" /> : null}
                Recreating {b.items.length} ad{b.items.length === 1 ? '' : 's'} for {(BRANDS[b.brand] || {}).name || b.brand}
                <span className="rc-sub"> · {b.status === 'running' ? done + ' done' + (failed ? ', ' + failed + ' failed' : '') : b.status === 'stopped' ? 'stopped' : 'finished, ' + done + ' made' + (failed ? ', ' + failed + ' failed' : '')}</span>
              </button>
              {b.status === 'running' && <button className="btn btn-ghost" type="button" onClick={() => stop(b)}>Stop</button>}
              {go && <button className="btn btn-ghost" type="button" onClick={() => go('drafts')}>Drafts</button>}
            </div>
            {isOpen && (
              <ul className="rc-items">
                {b.items.map((it) => (
                  <li key={it.key} className={'rc-item ' + it.stage}>
                    <span className="rc-label">{it.label}</span>
                    <span className="rc-stage">{itemText(it)}</span>
                    {it.mockups.some((m) => m.url) && (
                      <span className="rc-thumbs">{it.mockups.filter((m) => m.url).map((m) => <img key={m.draftId} src={m.url} alt="" loading="lazy" />)}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
