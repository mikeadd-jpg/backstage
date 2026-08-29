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
  const [mode, setMode] = useState('adults');   // adults | kids
  const [kidsGroups, setKidsGroups] = useState([]);   // [{key,label,blurb,regions}]
  const [adultGarments, setAdultGarments] = useState([]); // [{key,label}]
  const [pickKids, setPickKids] = useState({});   // groupKey -> [regions]
  const [pickAdults, setPickAdults] = useState([]); // [garmentKey]
  const [openAcc, setOpenAcc] = useState(true);
  const [progress, setProgress] = useState(''); // kids builds run in batches, so narrate them
  const [rows, setRows] = useState([]);         // per-product results as they land

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      const s = d.stores || [];
      setStores(s);
      const def = s.find((x) => x.is_default) || s[0];
      if (def) setShopId(def.printify_shop_id);
      const adults = (d.garments || []).filter((g) => (g.group || 'Adults') === 'Adults');
      setAdultGarments(adults);
      setPickAdults(adults.map((g) => g.key));      // everything on by default
    }).catch(() => {});

    fetch('/api/kids').then((r) => r.json()).then((d) => {
      const gs = d.groups || [];
      setKidsGroups(gs);
      const init = {};
      for (const g of gs) init[g.key] = g.regions.slice(); // everything on by default
      setPickKids(init);
    }).catch(() => {});
  }, []);

  // ---- selection helpers ----
  function toggleKidsRegion(groupKey, region) {
    setPickKids((p) => {
      const cur = p[groupKey] || [];
      const next = cur.includes(region) ? cur.filter((r) => r !== region) : [...cur, region];
      return { ...p, [groupKey]: next };
    });
  }
  function toggleKidsGroup(g) {
    setPickKids((p) => {
      const cur = p[g.key] || [];
      return { ...p, [g.key]: cur.length === g.regions.length ? [] : g.regions.slice() };
    });
  }
  function toggleAdult(key) {
    setPickAdults((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }
  const kidsCount = kidsGroups.reduce((n, g) => n + (pickKids[g.key] || []).length, 0);
  const selectedCount = mode === 'kids' ? kidsCount : pickAdults.length;

  async function pick(setter, file) {
    if (!file) { setter(null); return; }
    setter({ name: file.name, b64: await fileToB64(file) });
  }

  // Kids runs as one prepare call plus one call per garment group, so no single request
  // approaches the 60 second function limit. Results stream in group by group.
  async function buildKids() {
    setError(''); setResult(null); setRows([]); setProgress('');
    if (!shopId) return setError('Pick a store.');
    if (!designName.trim()) return setError('Enter a design name.');
    if (!front) return setError('Add a front design.');
    if (kidsCount === 0) return setError('Pick at least one product to build.');
    setBusy(true);

    try {
      setProgress('Uploading the design and writing descriptions...');
      const prepRes = await fetch('/api/kids', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'prepare', shopId, designName, vibe,
          frontB64: front.b64, frontName: front.name,
          backB64: back ? back.b64 : null, backName: back ? back.name : null,
        }),
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) { setError(prep.error || 'Prepare failed'); setBusy(false); return; }

      const allWarnings = [...(prep.warnings || [])];
      const collected = [];

      const chosen = prep.groups.filter((g) => (pickKids[g.key] || []).length > 0);
      for (const g of chosen) {
        const regions = pickKids[g.key] || [];
        setProgress('Building ' + g.label + ' (' + regions.join(', ') + ')...');
        const res = await fetch('/api/kids', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'build', shopId, groupKey: g.key, designName, leftChest, regions,
            description: prep.descriptions[g.key],
            frontId: prep.frontId, backId: prep.backId,
          }),
        });
        const d = await res.json();
        if (!res.ok) {
          collected.push({ label: g.label, ok: false, error: d.error || 'Build failed' });
        } else {
          collected.push(...d.results);
          allWarnings.push(...(d.warnings || []));
        }
        setRows([...collected]);
      }

      setProgress('');
      setResult({ designName, storeName: prep.storeName, warnings: allWarnings, results: collected });
    } catch (e) {
      setError('Something went wrong. Try again.');
      setProgress('');
    }
    setBusy(false);
  }

  async function build() {
    setError(''); setResult(null); setRows([]);
    if (!shopId) return setError('Pick a store.');
    if (!designName.trim()) return setError('Enter a design name.');
    if (!front) return setError('Add a front design.');
    if (pickAdults.length === 0) return setError('Pick at least one product to build.');
    setBusy(true);
    try {
      const res = await fetch('/api/builder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopId, designName, vibe, leftChest, garments: pickAdults,
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
      <div className="tabs" style={{ marginBottom: 10 }}>
        <button className={'tab' + (mode === 'adults' ? ' active' : '')} onClick={() => { setMode('adults'); setResult(null); setRows([]); setError(''); }}>Adults</button>
        <button className={'tab' + (mode === 'kids' ? ' active' : '')} onClick={() => { setMode('kids'); setResult(null); setRows([]); setError(''); }}>Kids</button>
      </div>
      <p className="pane-sub">
        {mode === 'adults'
          ? 'Upload one design, pick a store, and create 5 draft products in Printify.'
          : 'Upload one design and create draft products per region. UK and Canada name their own print provider because Printify Choice cannot fulfil kids garments. Untick anything you do not want.'}
      </p>

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

        {/* Which products to build. Everything starts checked; untick what you don't want. */}
        <div className="acc">
          <button className="acc-head" onClick={() => setOpenAcc((o) => !o)} type="button">
            <span className="acc-caret">{openAcc ? '\u25be' : '\u25b8'}</span>
            <span>Products to build</span>
            <span className="acc-count">{selectedCount} selected</span>
          </button>

          {openAcc && mode === 'kids' && (
            <div className="acc-body">
              {kidsGroups.length === 0 && <div className="ledger-note">Loading the kids catalog...</div>}
              {kidsGroups.map((g) => {
                const picked = pickKids[g.key] || [];
                return (
                  <div className="acc-group" key={g.key}>
                    <label className="check acc-group-head">
                      <input
                        type="checkbox"
                        checked={picked.length === g.regions.length}
                        ref={(el) => { if (el) el.indeterminate = picked.length > 0 && picked.length < g.regions.length; }}
                        onChange={() => toggleKidsGroup(g)}
                      />
                      <span className="li-name">{g.label}</span>
                      <span className="li-sub acc-blurb">{g.blurb}</span>
                    </label>
                    <div className="acc-regions">
                      {g.regions.map((r) => (
                        <label className="check acc-region" key={r}>
                          <input type="checkbox" checked={picked.includes(r)} onChange={() => toggleKidsRegion(g.key, r)} />
                          {r}
                        </label>
                      ))}
                      {g.regions.length < 3 && (
                        <span className="acc-note">
                          {g.key === 'ls_bodysuit' ? 'No UK provider exists for this garment' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {openAcc && mode === 'adults' && (
            <div className="acc-body">
              {adultGarments.length === 0 && <div className="ledger-note">Loading...</div>}
              {adultGarments.map((g) => (
                <label className="check acc-group-head" key={g.key}>
                  <input type="checkbox" checked={pickAdults.includes(g.key)} onChange={() => toggleAdult(g.key)} />
                  <span className="li-name">{g.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <div className="login-error">{error}</div>}

        <button className="btn btn-primary" onClick={mode === 'kids' ? buildKids : build} disabled={busy} style={{ marginTop: 8 }}>
          {busy
            ? 'Building ' + selectedCount + ' product' + (selectedCount === 1 ? '' : 's') + '...'
            : 'Build ' + selectedCount + ' ' + (mode === 'kids' ? 'kids ' : '') + 'product' + (selectedCount === 1 ? '' : 's')}
        </button>
        {busy && progress && <div className="ledger-note" style={{ marginTop: 8 }}>{progress}</div>}
      </div>

      {!result && rows.length > 0 && (
        <div className="card">
          <div className="card-label">Progress</div>
          {rows.map((r, i) => (
            <div className="build-row" key={i}>
              <span className="li-name">{r.label}</span>
              {r.ok
                ? <span className="status-pill s-shipped"><span className="mini-dot" style={{ background: 'var(--green)' }} />Created</span>
                : <span className="status-pill s-action" title={r.error}><span className="mini-dot" style={{ background: 'var(--red)' }} />Failed</span>}
            </div>
          ))}
        </div>
      )}

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
                ? <span className="status-pill s-shipped"><span className="mini-dot" style={{ background: 'var(--green)' }} />Created{r.variants ? ' \u00b7 ' + r.variants + ' variants' : ''}</span>
                : <span className="status-pill s-action" title={r.error}><span className="mini-dot" style={{ background: 'var(--red)' }} />Failed</span>}
            </div>
          ))}
          <p className="pane-sub" style={{ marginTop: 12 }}>Created as drafts. Review and publish them in Printify.</p>
        </div>
      )}
    </div>
  );
}
