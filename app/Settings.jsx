'use client';
import { useEffect, useState } from 'react';

const CS_BRANDS = ['elderemo', 'poppunks', 'wallspoke'];
const BRAND_NAMES = { elderemo: 'Elder Emo', poppunks: 'PopPunks', wallspoke: 'Wallspoke' };

export default function Settings() {
  const [data, setData] = useState(null);
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState(null);   // null until loaded; [] means none yet
  const [newUser, setNewUser] = useState({ email: '', role: 'member' });
  const [userMsg, setUserMsg] = useState('');
  const [voices, setVoices] = useState({});
  const [structure, setStructure] = useState('');
  const [cfg, setCfg] = useState({}); // `${brand}|${garment}` -> { price, tags }
  const [newStore, setNewStore] = useState({ name: '', brandKey: '', printifyShopId: '', isDefault: false, copyFrom: '' });
  const [storeMsg, setStoreMsg] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => { load(); loadMe(); }, []);

  async function loadMe() {
    const d = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
    setMe(d.user || null);
    if (d.user && d.user.role === 'admin') loadUsers();
  }
  async function loadUsers() {
    const d = await fetch('/api/users').then((r) => r.json()).catch(() => ({}));
    setUsers(d.users || []);
  }
  async function addUser() {
    setUserMsg('');
    const d = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    }).then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    if (d.error) return setUserMsg(d.error);
    setNewUser({ email: '', role: 'member' });
    loadUsers();
    flash('User saved');
  }
  async function removeUser(email) {
    setUserMsg('');
    const d = await fetch('/api/users?email=' + encodeURIComponent(email), { method: 'DELETE' })
      .then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    if (d.error) return setUserMsg(d.error);
    loadUsers();
    flash('Access removed');
  }
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
    const d = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    if (d && d.error) { setStoreMsg(d.error); return d; }
    flash(msg);
    return d;
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
            {['Adults', 'Kids'].map((groupName) => {
              const inGroup = garments.filter((g) => (g.group || 'Adults') === groupName);
              if (!inGroup.length) return null;
              return (
                <div key={groupName}>
                  <div className="eyebrow" style={{ marginTop: 10 }}>{groupName}</div>
                  {inGroup.map((g) => {
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
              );
            })}
          </div>
        ))}
      </div>

      {/* Who can sign in. Admin only: this is the single thing the role gates. */}
      {me && me.role === 'admin' && (
        <div className="card">
          <div className="card-label">Who can sign in</div>
          <p className="pane-sub" style={{ marginTop: 0 }}>
            Anyone listed here can sign in with that Google account. Admins can also manage this list.
          </p>
          {users === null && <div className="ledger-note">Loading...</div>}
          {users && users.map((u) => (
            <div className="build-row" key={u.email}>
              <span className="li-name">
                {u.name || u.email}
                <span className="li-sub" style={{ display: 'inline', marginLeft: 8 }}>
                  {u.name ? u.email + ' · ' : ''}{u.role}
                  {u.last_seen ? ' · last seen ' + new Date(u.last_seen).toLocaleDateString() : ' · never signed in'}
                </span>
              </span>
              {u.email !== me.email && (
                <button className="btn btn-ghost" onClick={() => removeUser(u.email)}>Remove</button>
              )}
            </div>
          ))}
          <div className="field-row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: 2 }}>
              <span>Google email</span>
              <input className="input" placeholder="person@gmail.com" value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
            </label>
            <label className="field">
              <span>Role</span>
              <select className="input" value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          {userMsg && <div className="login-error" style={{ marginTop: 8 }}>{userMsg}</div>}
          <button className="btn btn-primary" style={{ marginTop: 8, alignSelf: 'flex-start' }}
            onClick={addUser}>Add / update user</button>
        </div>
      )}

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
        <label className="field" style={{ marginTop: 10 }}>
          <span>Copy pricing, tags and voice from</span>
          <select className="input" value={newStore.copyFrom} onChange={(e) => setNewStore({ ...newStore, copyFrom: e.target.value })}>
            <option value="">Nothing, start empty</option>
            {(data.stores || []).map((s2) => <option key={s2.brand_key} value={s2.brand_key}>{s2.name}</option>)}
          </select>
        </label>
        <p className="pane-sub" style={{ marginTop: 0 }}>
          Copies every garment price and tag list across, swapping the brand name inside the tags.
          Nothing already set on the new store is overwritten. Edit the copied voice, it still describes the old brand.
        </p>

        <label className="check"><input type="checkbox" checked={newStore.isDefault} onChange={(e) => setNewStore({ ...newStore, isDefault: e.target.checked })} /> Default store</label>
        {storeMsg && <div className="ledger-note" style={{ marginTop: 6 }}>{storeMsg}</div>}
        <button className="btn btn-primary" style={{ marginTop: 8, alignSelf: 'flex-start' }}
          onClick={async () => {
            setStoreMsg('');
            const d = await post({ kind: 'store', ...newStore }, 'Store saved');
            if (d && d.error) return;                       // validation failed, keep the form filled in
            if (d && d.copy) {
              const c = d.copy;
              setStoreMsg(
                'Copied ' + c.copied + ' of ' + c.available + ' product rows' +
                (c.skipped ? ' (' + c.skipped + ' already set, left alone)' : '') +
                (c.voiceCopied ? ' and the brand voice.' : '.')
              );
            }
            setNewStore({ name: '', brandKey: '', printifyShopId: '', isDefault: false, copyFrom: '' });
            load();
          }}>Add / update store</button>
      </div>
    </div>
  );
}
