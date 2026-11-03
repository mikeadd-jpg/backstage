'use client';
// Brand voice, reply structure, mockup notes, stores, product pricing, the video brand kit
// and the Canva connection. Who can sign in moved to its own Users screen (app/Users.jsx),
// opened from the account menu.
//
// Laid out by brand: each brand is one expandable block holding everything that belongs
// to it, and "All stores" holds what is shared. Which blocks are open is remembered on
// this device only.
import { createContext, useContext, useEffect, useState } from 'react';
import BrandKit from './BrandKit.jsx';

const OPEN_KEY = 'backstage.settingsOpen';
function readOpen() {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch { return []; }
}

// A <details> whose open state survives a reload. Children render only while open, so a
// brand's kit loads when someone opens it. Defined out here, not inside Settings, or every
// keystroke would remount the text boxes inside it.
const OpenState = createContext({ open: [], toggle: () => {} });
function Section({ id, title, sub, children, top }) {
  const { open, toggle } = useContext(OpenState);
  const isOpen = open.includes(id);
  return (
    <details className={top ? 'set-block' : 'set-sec'} open={isOpen}
      onToggle={(e) => { if (e.currentTarget.open !== isOpen) toggle(id, e.currentTarget.open); }}>
      <summary>
        <span className={top ? 'set-block-title' : 'set-sec-title'}>{title}</span>
        {sub && <span className="li-sub set-sum-sub">{sub}</span>}
      </summary>
      <div className={top ? 'set-block-body' : 'set-sec-body'}>{isOpen ? children : null}</div>
    </details>
  );
}

const CS_BRANDS = ['elderemo', 'poppunks', 'wallspoke'];
const BRAND_NAMES = { elderemo: 'Elder Emo', poppunks: 'PopPunks', wallspoke: 'Wallspoke' };

export default function Settings() {
  const [data, setData] = useState(null);
  const [voices, setVoices] = useState({});
  const [structure, setStructure] = useState('');
  const [mockupNotes, setMockupNotes] = useState({});
  const [cfg, setCfg] = useState({}); // `${brand}|${garment}` -> { price, tags }
  const [newStore, setNewStore] = useState({ name: '', brandKey: '', printifyShopId: '', isDefault: false, copyFrom: '' });
  const [storeMsg, setStoreMsg] = useState('');
  const [saved, setSaved] = useState('');
  const [canva, setCanva] = useState(null);
  const [canvaMsg, setCanvaMsg] = useState('');
  const [open, setOpen] = useState([]);         // ids of the expanded blocks and sections

  useEffect(() => { setOpen(readOpen()); }, []);
  function toggle(id, isOpen) {
    setOpen((o) => {
      const next = isOpen ? [...new Set([...o, id])] : o.filter((x) => x !== id);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* per-device convenience only */ }
      return next;
    });
  }


  useEffect(() => { load(); loadCanva(); }, []);

  // The Canva callback lands back here with ?canva=connected or ?canva_error=...; show it
  // once, then drop the query so a refresh does not repeat it.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('canva') === 'connected') setCanvaMsg('Canva connected.');
    else if (sp.get('canva_error')) setCanvaMsg(sp.get('canva_error'));
    if (sp.has('canva') || sp.has('canva_error')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    }
  }, []);

  async function loadCanva() {
    const d = await fetch('/api/canva').then((r) => r.json()).catch(() => null);
    if (d && !d.error) setCanva(d);
  }
  async function disconnectCanva() {
    if (!window.confirm('Disconnect Canva? Send to Canva stops working until someone connects it again. Nothing already in Canva is touched.')) return;
    const d = await fetch('/api/canva', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disconnect' }),
    }).then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    if (d.error) setCanvaMsg(d.error);
    else { setCanva(d); setCanvaMsg('Canva disconnected.'); }
  }

  async function load() {
    const d = await fetch('/api/settings').then((r) => r.json());
    setData(d);
    setVoices(d.voices || {});
    setStructure(d.replyStructure || '');
    setMockupNotes(d.mockupNotes || {});
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

  const storeFor = (b) => (data.stores || []).find((s) => s.brand_key === b);
  const nameOf = (b) => BRAND_NAMES[b] || (storeFor(b) || {}).name || b;

  return (
    <OpenState.Provider value={{ open, toggle }}>
    <div className="pane">
      <div className="pane-head">Settings {saved && <span className="edited-tag" style={{ marginLeft: 8 }}>{saved}</span>}</div>
      <p className="pane-sub">Everything for one store sits under its name. Brand voice is shared: it drives both product descriptions and customer-service reply drafts.</p>
      {storeMsg && <div className="ledger-note" style={{ marginBottom: 10 }}>{storeMsg}</div>}

      {brandKeys.map((b) => {
        const s = storeFor(b);
        return (
          <Section top key={b} id={'brand:' + b} title={nameOf(b)}
            sub={[s ? 'Printify shop ' + s.printify_shop_id : null, (voices[b] || '').trim() ? null : 'no voice yet'].filter(Boolean).join(' · ')}>

            <Section id={b + ':voice'} title="Brand voice" sub="Product descriptions and reply drafts">
              <textarea className="textarea" value={voices[b] || ''} onChange={(e) => setVoices((v) => ({ ...v, [b]: e.target.value }))} rows={6} />
              <button className="btn btn-ghost" style={{ marginTop: 6, alignSelf: 'flex-start' }}
                onClick={() => post({ kind: 'voice', brandKey: b, voice: voices[b] || '' }, 'Voice saved')}>Save voice</button>
            </Section>

            {CS_BRANDS.includes(b) && (
              <Section id={b + ':mockups'} title="Mockup notes" sub="Standing direction for every lifestyle shot">
                <p className="pane-sub" style={{ marginTop: 0 }}>
                  Who should or should not be in the frame, how close to frame the product. Rotated scenes are written to
                  respect it too. Leave empty for none.
                </p>
                <textarea className="textarea" rows={3} value={mockupNotes[b] || ''}
                  placeholder={b === 'elderemo' ? 'e.g. No visible tattoos on anyone in the frame.' : 'e.g. Frame the print tight so it fills most of the image.'}
                  onChange={(e) => setMockupNotes((n) => ({ ...n, [b]: e.target.value }))} />
                <button className="btn btn-ghost" style={{ marginTop: 6, alignSelf: 'flex-start' }}
                  onClick={() => post({ kind: 'mockupNotes', brandKey: b, notes: mockupNotes[b] || '' }, 'Notes saved')}>Save notes</button>
              </Section>
            )}

            {CS_BRANDS.includes(b) && (
              <Section id={b + ':kit'} title="Video brand kit" sub="End cards, logos, fonts and music for the video builder">
                <BrandKit brand={b} brandName={nameOf(b)} />
              </Section>
            )}

            {s && (
              <Section id={b + ':pricing'} title="Product pricing & tags" sub="What the product builder sets on each garment">
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
              </Section>
            )}
          </Section>
        );
      })}

      <Section top id="shared" title="All stores" sub="Reply structure, Canva and the store list">
        <Section id="shared:reply" title="Customer-service reply structure" sub="The skeleton every reply follows">
          <p className="pane-sub" style={{ marginTop: 0 }}>The shared skeleton every reply follows. The apology fires only when something went wrong.</p>
          <textarea className="textarea" value={structure} onChange={(e) => setStructure(e.target.value)} rows={8} />
          <button className="btn btn-ghost" style={{ marginTop: 6, alignSelf: 'flex-start' }}
            onClick={() => post({ kind: 'replyStructure', value: structure }, 'Structure saved')}>Save reply structure</button>
        </Section>
        <Section id="shared:canva" title="Canva" sub={canva && canva.connected ? 'Connected' : 'Not connected'}>
        <p className="pane-sub" style={{ marginTop: 0 }}>
          Send to Canva on the Mockups tab uploads an approved shot into a folder per brand
          (Backstage · Elder Emo mockups and so on) in the connected Canva account, ready to
          build a reel from. The Ads tab reads that account's designs and exports a finished
          reel as a video ad. It never creates, edits or posts a design.
        </p>
        {!canva ? <p className="pane-sub">Loading...</p>
          : !canva.configured ? (
            <div className="ledger-note">
              CANVA_CLIENT_ID and CANVA_CLIENT_SECRET are not set. Create an integration in
              Canva's Developer Portal, add {window.location.origin}/api/canva/callback as a
              redirect URL, and set both on the server.
            </div>
          ) : canva.connected ? (
            <div className="build-row">
              <span className="li-name">
                Connected
                <span className="li-sub" style={{ display: 'inline' }}>
                  {' '}by {canva.by || 'someone'}{canva.at ? ' on ' + new Date(canva.at).toLocaleDateString() : ''}
                </span>
              </span>
              <a className="btn btn-ghost" href="/api/canva/connect">Reconnect</a>
              <button className="btn btn-ghost" onClick={disconnectCanva}>Disconnect</button>
            </div>
          ) : (
            <a className="btn btn-primary" style={{ alignSelf: 'flex-start' }} href="/api/canva/connect">Connect Canva</a>
          )}
        {canva && canva.connected && !canva.designs && (
          <div className="ledger-note" style={{ marginTop: 8 }}>
            Video ads on the Ads tab need this connection to read designs. In Canva's Developer Portal, tick
            design:meta:read and design:content:read on the integration, then press Reconnect.
          </div>
        )}
        {canvaMsg && <div className="ledger-note" style={{ marginTop: 8 }}>{canvaMsg}</div>}
        </Section>
        <Section id="shared:stores" title="Stores" sub="Add a store or change its Printify shop">
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
        </Section>
      </Section>
    </div>
    </OpenState.Provider>
  );
}
