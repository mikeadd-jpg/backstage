'use client';
// The Brief tab: where every ad starts. Either an idea, typed or spoken into the device
// (the browser's own speech recognition, no audio leaves it except as the text it writes),
// which Claude turns into a filled-in brief (lib/recreate.js, fillBrief), or a competitor
// ad sent over from Inspiration, whose breakdown arrives filled in (`backstage.briefSeed`
// in sessionStorage, read once). Either way the brief below is edited and approved before
// anything is made (app/BriefEditor.jsx). Saved templates start one too.
import { useEffect, useRef, useState } from 'react';
import BriefEditor from './BriefEditor.jsx';
import Batches from './Batches.jsx';

export const BRIEF_SEED_KEY = 'backstage.briefSeed';

async function api(payload) {
  const res = await fetch('/api/recreate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Request failed.');
  return d;
}

// Speech to text with the browser's own recogniser (Chrome, Edge, Safari on iPhone and
// Mac). `onText(final, interim)` gets the words as they come.
function useDictation(onText) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef(null);
  const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  function start() {
    if (!Rec) return;
    setError('');
    const r = new Rec();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let fin = '', mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (mid += e.results[i][0].transcript));
      onText(fin, mid);
    };
    r.onerror = (e) => setError(e.error === 'not-allowed' ? 'Allow the microphone for this site to dictate.' : e.error === 'no-speech' ? '' : 'Dictation stopped: ' + e.error);
    r.onend = () => { setOn(false); onText('', ''); };
    rec.current = r;
    r.start();
    setOn(true);
  }
  function stop() { if (rec.current) rec.current.stop(); }
  useEffect(() => () => { if (rec.current) rec.current.abort(); }, []);
  return { supported: Boolean(Rec), on, start, stop, error };
}

export default function Brief({ go }) {
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');
  const [idea, setIdea] = useState('');
  const [interim, setInterim] = useState('');
  const [filling, setFilling] = useState(false);
  const [error, setError] = useState('');
  const [brief, setBrief] = useState(null);           // { initial, productHint, source, from }
  const [n, setN] = useState(0);                       // remounts the editor on each new brief
  const [refresh, setRefresh] = useState(0);           // reloads the batches panel
  const dict = useDictation((fin, mid) => {
    if (fin) setIdea((t) => (t ? t.replace(/\s*$/, ' ') : '') + fin.trim());
    setInterim(mid);
  });

  useEffect(() => {
    fetch('/api/recreate', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const list = d.brands || [];
      setBrands(list);
      let seed = null;
      try { seed = JSON.parse(sessionStorage.getItem(BRIEF_SEED_KEY) || 'null'); sessionStorage.removeItem(BRIEF_SEED_KEY); } catch { /* none */ }
      const start = (seed && list.some((b) => b.key === seed.brand) && seed.brand) || (list[0] && list[0].key) || '';
      setBrand(start);
      if (seed && seed.brief) { setBrief({ initial: seed.brief, productHint: seed.productHint || '', source: seed.source || null, from: seed.from || null }); setN((x) => x + 1); }
    }).catch(() => setError('Could not load the stores.'));
  }, []);

  async function fill() {
    if (dict.on) dict.stop();
    setFilling(true); setError('');
    try {
      const d = await api({ action: 'fill-brief', brand, idea });
      const { productHint, ...rest } = d.brief;
      setBrief({ initial: rest, productHint, source: null, from: null });
      setN((x) => x + 1);
    } catch (e) { setError(e.message); } finally { setFilling(false); }
  }

  return (
    <div className="pane insp-pane">
      <div className="pane-head">Brief</div>
      <p className="pane-sub">Every ad starts here. Say or type an idea, or start from a competitor ad in Inspiration, then check the brief and approve it.</p>
      <Batches refresh={refresh} go={go} />

      <div className="card">
        <div className="card-label">Start from an idea</div>
        <div className="field-row">
          <label className="field">
            <span>Store</span>
            <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
              {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span>The idea, as loose as you like</span>
          <textarea className="input" rows={4} value={idea + (interim ? (idea ? ' ' : '') + interim : '')} onChange={(e) => { setIdea(e.target.value); setInterim(''); }}
            placeholder="e.g. An anniversary ad for the love map, warm and quiet, a couple's living room, mention free shipping, headline 'Where it all began.'" />
        </label>
        <div className="reply-actions">
          {dict.supported ? (
            <button type="button" className={'btn ' + (dict.on ? 'btn-danger' : 'btn-ghost')} onClick={dict.on ? dict.stop : dict.start}>
              {dict.on ? '■ Stop' : '🎙 Speak it'}
            </button>
          ) : (
            <span className="ledger-note">To speak it, tap the microphone on your keyboard.</span>
          )}
          <button type="button" className="btn btn-primary" onClick={fill} disabled={filling || !brand || idea.trim().length < 4}>
            {filling ? 'Writing the brief...' : brief ? 'Fill in a new brief' : 'Fill in the brief'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => { setBrief({ initial: null, productHint: '', source: null, from: null }); setN((x) => x + 1); }}>
            Blank brief or a template
          </button>
        </div>
        {dict.on && <div className="ledger-note" style={{ marginTop: 6 }}>Listening... speak naturally, then press Stop.</div>}
        {dict.error && <div className="login-error" style={{ marginTop: 6 }}>{dict.error}</div>}
        {error && <div className="login-error" style={{ marginTop: 6 }}>{error}</div>}
        <div className="ledger-note" style={{ marginTop: 8 }}>
          Or start from a competitor ad: open one in <button type="button" className="link-inline" onClick={() => go('inspiration')}>Inspiration</button> and press "Make a brief from this".
        </div>
      </div>

      {brief && brief.from && (
        <div className="card brief-from">
          {brief.from.image && <img src={brief.from.image} alt="" />}
          <div>
            <div className="card-label" style={{ marginBottom: 4 }}>From {brief.from.competitor || 'a competitor'}'s ad</div>
            {brief.from.headline && <div className="li-name">{brief.from.headline}</div>}
            {brief.from.why && <p className="insp-p" style={{ margin: '6px 0 0' }}><b>Why it works:</b> {brief.from.why}</p>}
          </div>
        </div>
      )}

      {brief && brand && (
        <div className="card">
          <BriefEditor key={n + ':' + brand} brands={brands} brand={brand} initial={brief.initial} productHint={brief.productHint} source={brief.source}
            onStarted={() => setRefresh((x) => x + 1)} onClose={() => setBrief(null)} />
          <div className="reply-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => go('drafts')}>Open Drafts</button>
          </div>
        </div>
      )}
    </div>
  );
}
