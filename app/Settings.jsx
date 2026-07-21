'use client';
import { useEffect, useState } from 'react';

const CS_BRANDS = ['elderemo', 'poppunks', 'wallspoke'];
const BRAND_NAMES = { elderemo: 'Elder Emo', poppunks: 'PopPunks', wallspoke: 'Wallspoke' };

export default function Settings() {
  const [data, setData] = useState(null);
  const [voices, setVoices] = useState({});
  const [structure, setStructure] = useState('');
  const [cfg, setCfg] = useState({}); // `${brand}|${garment}` -> { price, tags }
  const [newStore, setNewStore] = useState({ name: '', brandKey: '', printifyShopId: '', isDefault: false });
  const [saved, setSaved] = useState('');

  useEffect(() => { load(); }, []);
  async function load() {
    const d = await fetch('/api/settings').then((r) => r.json());
    setData(d);
    setVoices(d.voices || {});
    setStructure(d.replyStructure || '');
    const map = {};
    for (const c of d.config || []) map[c.brand_key + '|' + c.garment_key] = { price: (c.price_cents / 100).toFixed(2), tags: c.tags || '' };
    setCfg(map);
  }
  function flash(msg) { setSaved(msg); setTimeout(() => setSaved(''), 1500); }
  async function post(body, msg) {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    flash(msg);
  }

  if (!data) return <div className="pane"><div className="pane-head">Settings</div><p className="pane-sub">Loading...</p></div>;

  const brandKeys = Array.from(new Set([...(data.stores || []).map((s) => s.brand_key), ...CS_BRANDS]));
  const garments = data.garments || [];

  return (
    <div className="pane">
      <div className="pane-head">Settings {saved && <span className="edited-tag" style={{ marginLeft: 8 }}>{saved}</span>}</div>
      <p className="pane-sub">Brand voice here is shared: it drives both product descriptions and customer-service reply drafts.</p>

      {/* Brand voices */}
      <div className="card">
        <div className="card-label">Brand voice (shared)</div>
        {brandKeys.map((b) => (
          <div className="field" key={b}>
            <span>{BRAND_NAMES[b] || b}</span>
            <textarea className="textarea" value={voices[b] || ''} onChange={(e) => setVoices((v) => ({ ...v, [b]: e.target.value }))} rows={5} />
            <button className="btn btn-ghost" style={{ marginTop: 6, alignSelf: 'flex-start' }}
              onClick={() => post({ kind: 'voice', brandKey: b, voice: voices[b] || '' }, 'Voice saved')}>Save {BRAND_NAMES[b] || b} voice</button>
          </div>
        ))}
      </div>

      {/* CS reply structure */}
      <div className="card">
        <div className="card-label">Customer-service reply structure</div>
        <p className="pane-sub" style={{ marginTop: 0 }}>The shared skeleton every reply follows. The apology fires only when something went wrong.</p>
        <textarea className="textarea" value={structure} onChange={(e) => setStructure(e.target.value)} rows={8} />
        <button className="btn btn-ghost" style={{ marginTop: 6, alignSelf: 'flex-start' }}
          onClick={() => post({ kind: 'replyStructure', value: structure }, 'Structure saved')}>Save reply structure</button>
      </div>

      {/* Product pricing + tags */}
      <div className="card">
        <div className="card-label">Product pricing &amp; tags</div>
        {(data.stores || []).length === 0 && <p className="pane-sub">Add a store below to configure products.</p>}
        {(data.stores || []).map((s) => (
          <div key={s.brand_key} style={{ marginBottom: 18 }}>
            <div className="li-name" style={{ marginBottom: 8 }}>{s.name}</div>
            {garments.map((g) => {
              const k = s.brand_key + '|' + g.key;
              const row = cfg[k] || { price: '', tags: '' };
              return (
                <div className="cfg-row" key={k}>
                  <span className="cfg-label">{g.label}</span>
                  <input className="input cfg-price" placeholder="24.99" value={row.price}
                    onChange={(e) => setCfg((c) => ({ ...c, [k]: { ...row, price: e.target.value } }))} />
                  <input className="input cfg-tags" placeholder="comma, separated, tags" value={row.tags}
                    onChange={(e) => setCfg((c) => ({ ...c, [k]: { ...row, tags: e.target.value } }))} />
                  <button className="btn btn-ghost" onClick={() => post({ kind: 'config', brandKey: s.brand_key, garmentKey: g.key, price: row.price || 0, tags: row.tags || '' }, 'Saved')}>Save</button>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Stores */}
      <div className="card">
        <div className="card-label">Stores</div>
        {(data.stores || []).map((s) => (
          <div className="build-row" key={s.brand_key}>
            <span className="li-name">{s.name} <span className="li-sub" style={{ display: 'inline' }}>({s.brand_key} · shop {s.printify_shop_id}){s.is_default ? ' · default' : ''}</span></span>
          </div>
        ))}
        <div className="field-row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <label className="field"><span>Name</span><input className="input" value={newStore.name} onChange={(e) => setNewStore({ ...newStore, name: e.target.value })} /></label>
          <label className="field"><span>Brand key</span><input className="input" placeholder="elderemo" value={newStore.brandKey} onChange={(e) => setNewStore({ ...newStore, brandKey: e.target.value })} /></label>
          <label className="field"><span>Printify shop id</span><input className="input" value={newStore.printifyShopId} onChange={(e) => setNewStore({ ...newStore, printifyShopId: e.target.value })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={newStore.isDefault} onChange={(e) => setNewStore({ ...newStore, isDefault: e.target.checked })} /> Default store</label>
        <button className="btn btn-primary" style={{ marginTop: 8, alignSelf: 'flex-start' }}
          onClick={async () => { await post({ kind: 'store', ...newStore }, 'Store saved'); setNewStore({ name: '', brandKey: '', printifyShopId: '', isDefault: false }); load(); }}>Add / update store</button>
      </div>
    </div>
  );
}
