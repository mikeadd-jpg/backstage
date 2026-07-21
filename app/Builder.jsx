'use client';
import { useEffect, useState } from 'react';

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Builder() {
  const [stores, setStores] = useState([]);
  const [shopId, setShopId] = useState('');
  const [designName, setDesignName] = useState('');
  const [vibe, setVibe] = useState('');
  const [leftChest, setLeftChest] = useState(false);
  const [front, setFront] = useState(null);
  const [back, setBack] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      const s = d.stores || [];
      setStores(s);
      const def = s.find((x) => x.is_default) || s[0];
      if (def) setShopId(def.printify_shop_id);
    }).catch(() => {});
  }, []);

  async function pick(setter, file) {
    if (!file) { setter(null); return; }
    setter({ name: file.name, b64: await fileToB64(file) });
  }

  async function build() {
    setError(''); setResult(null);
    if (!shopId) return setError('Pick a store.');
    if (!designName.trim()) return setError('Enter a design name.');
    if (!front) return setError('Add a front design.');
    setBusy(true);
    try {
      const res = await fetch('/api/builder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId, designName, vibe, leftChest,
          frontB64: front.b64, frontName: front.name,
          backB64: back ? back.b64 : null, backName: back ? back.name : null,
        }),
      });
      const d = await res.json();
      if (!res.ok) setError(d.error || 'Build failed');
      else setResult(d);
    } catch (e) { setError('Something went wrong. Try again.'); }
    setBusy(false);
  }

  return (
    <div className="pane">
      <div className="pane-head">Product Builder</div>
      <p className="pane-sub">Upload one design, pick a store, and create 5 draft products in Printify.</p>

      <div className="card">
        <label className="field">
          <span>Store</span>
          <select className="input" value={shopId} onChange={(e) => setShopId(e.target.value)}>
            {stores.length === 0 && <option value="">No stores yet, add one in Settings</option>}
            {stores.map((s) => <option key={s.printify_shop_id} value={s.printify_shop_id}>{s.name}</option>)}
          </select>
        </label>

        <label className="field">
          <span>Design name</span>
          <input className="input" value={designName} onChange={(e) => setDesignName(e.target.value)} placeholder="e.g. Still Emo" />
        </label>

        <label className="field">
          <span>Vibe / notes (optional)</span>
          <input className="input" value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="what the design is about, tone, references" />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Front design</span>
            <input type="file" accept="image/*" onChange={(e) => pick(setFront, e.target.files[0])} />
          </label>
          <label className="field">
            <span>Back design (optional)</span>
            <input type="file" accept="image/*" onChange={(e) => pick(setBack, e.target.files[0])} />
          </label>
        </div>

        <label className="check">
          <input type="checkbox" checked={leftChest} onChange={(e) => setLeftChest(e.target.checked)} />
          Place front design as a small left-chest print
        </label>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary" onClick={build} disabled={busy} style={{ marginTop: 8 }}>
          {busy ? 'Building 5 products...' : 'Build products'}
        </button>
      </div>

      {result && (
        <div className="card">
          <div className="card-label">Result: {result.designName} &rarr; {result.storeName}</div>
          {result.warnings && result.warnings.map((w, i) => (
            <div className="flag" key={i} style={{ marginBottom: 10 }}><span className="ico">&#9873;</span><span>{w}</span></div>
          ))}
          {result.results.map((r, i) => (
            <div className="build-row" key={i}>
              <span className="li-name">{r.label}</span>
              {r.ok
                ? <span className="status-pill s-shipped"><span className="mini-dot" style={{ background: 'var(--green)' }} />Created</span>
                : <span className="status-pill s-action" title={r.error}><span className="mini-dot" style={{ background: 'var(--red)' }} />Failed</span>}
            </div>
          ))}
          <p className="pane-sub" style={{ marginTop: 12 }}>Created as drafts. Review and publish them in Printify.</p>
        </div>
      )}
    </div>
  );
}
