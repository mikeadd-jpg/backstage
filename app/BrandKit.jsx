'use client';
// One brand's video kit in Settings: end card images, logos, fonts and approved music,
// kept for good and offered by the Ads tab's video builder. Files go from the browser
// straight to Vercel Blob (/api/brand-kit/upload hands out a token for one path), then
// /api/brand-kit records them with what the browser measured: an image's size, a song's
// length and tempo. The first file of each kind is the brand's default.
import { useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { KIT_KINDS, KIT_KEYS, kitContentType, kitPrefix } from '../lib/kitKinds.js';
import { probeImage, probeAudio } from './mediaProbe.js';

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const stem = (name) => String(name).replace(/\.[^.]+$/, '');
const safe = (name) => String(name).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'file';

// A font is checked by actually loading it, so a broken file never reaches the kit.
async function probeFont(file) {
  const face = new FontFace('bk-probe-' + Date.now(), await file.arrayBuffer());
  await face.load().catch(() => { throw new Error(file.name + ' is not a font the browser can read.'); });
  return {};
}

async function measure(kind, file) {
  if (kind === 'music') {
    const { seconds, beat } = await probeAudio(file);
    return { seconds, ...(beat || {}) };
  }
  if (kind === 'font') return probeFont(file);
  const src = URL.createObjectURL(file);
  try {
    const { width, height } = await probeImage(src);
    return { width, height };
  } finally {
    URL.revokeObjectURL(src);
  }
}

// Fonts load once per page under their kit id, which the samples here and the video
// builder both use, so two brands' "Bold" never collide.
export function kitFontFamily(id) { return 'bk-font-' + id; }
const loadedFonts = new Map();
export function loadKitFont(asset) {
  if (!loadedFonts.has(asset.id)) {
    const face = new FontFace(kitFontFamily(asset.id), 'url(' + JSON.stringify(asset.url) + ')');
    loadedFonts.set(asset.id, face.load().then((f) => { document.fonts.add(f); return f; }));
  }
  return loadedFonts.get(asset.id);
}

export default function BrandKit({ brand, brandName }) {
  const [assets, setAssets] = useState(null);
  const [storage, setStorage] = useState(true);
  const [busy, setBusy] = useState({});            // kind -> 'Uploading 2 of 3...'
  const [msg, setMsg] = useState({});              // kind -> message
  const [editing, setEditing] = useState(null);    // { id, name }
  const inputs = useRef({});

  useEffect(() => {
    fetch('/api/brand-kit?brand=' + encodeURIComponent(brand)).then((r) => r.json()).then((d) => {
      if (d.error) return setMsg({ _: d.error });
      setAssets(d.assets || []); setStorage(d.storage !== false);
    }).catch(() => setMsg({ _: 'Could not load the brand kit.' }));
  }, [brand]);

  useEffect(() => {
    for (const a of assets || []) if (a.kind === 'font') loadKitFont(a).catch(() => {});
  }, [assets]);

  async function act(body) {
    const d = await fetch('/api/brand-kit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => ({ error: 'Request failed.' }));
    if (d.error) throw new Error(d.error);
    return d;
  }

  async function addFiles(kind, files) {
    const k = KIT_KINDS[kind];
    const list = [...files];
    setMsg((m) => ({ ...m, [kind]: '' }));
    const errors = [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setBusy((b) => ({ ...b, [kind]: 'Uploading ' + (i + 1) + ' of ' + list.length + '...' }));
      try {
        const contentType = kitContentType(kind, file);
        if (!k.types.includes(contentType)) throw new Error(file.name + ' is not a ' + k.label.toLowerCase().replace(/s$/, '') + ' file this kit takes.');
        if (file.size > k.max) throw new Error(file.name + ' is over ' + mb(k.max) + '.');
        const meta = await measure(kind, file);
        const blob = await upload(kitPrefix(brand, kind) + safe(file.name), file, {
          access: 'public',
          handleUploadUrl: '/api/brand-kit/upload',
          clientPayload: JSON.stringify({ brand, kind }),
          contentType,
          multipart: file.size > 8 * 1024 * 1024,
        });
        const d = await act({ action: 'add', brand, kind, pathname: blob.pathname, name: stem(file.name), meta });
        setAssets((xs) => [...(xs || []), d.asset]);
      } catch (err) {
        errors.push(String(err.message || err));
      }
    }
    setBusy((b) => ({ ...b, [kind]: '' }));
    setMsg((m) => ({ ...m, [kind]: errors.join(' ') }));
    if (inputs.current[kind]) inputs.current[kind].value = '';
  }

  async function run(kind, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const d = await act(body);
      setAssets(d.assets);
      setEditing(null);
    } catch (err) {
      setMsg((m) => ({ ...m, [kind]: String(err.message || err) }));
    }
  }

  if (msg._) return <div className="ledger-note">{msg._}</div>;
  if (!assets) return <div className="ledger-note">Loading...</div>;
  if (!storage) {
    return <div className="ledger-note">BLOB_READ_WRITE_TOKEN is not set, so there is nowhere to keep brand files. Connect the Blob store to the project in Vercel.</div>;
  }

  return (
    <div className="kit">
      {KIT_KEYS.map((kind) => {
        const k = KIT_KINDS[kind];
        const items = assets.filter((a) => a.kind === kind);
        return (
          <div className="kit-group" key={kind}>
            <div className="kit-head">
              <div>
                <div className="li-name">{k.label} <span className="acc-count">{items.length || ''}</span></div>
                <div className="li-sub">{k.about}</div>
              </div>
              <button className="btn btn-ghost" type="button" disabled={Boolean(busy[kind])}
                onClick={() => inputs.current[kind] && inputs.current[kind].click()}>
                {busy[kind] || '+ Add'}
              </button>
              <input ref={(el) => { inputs.current[kind] = el; }} type="file" multiple accept={k.accept} style={{ display: 'none' }}
                onChange={(e) => addFiles(kind, e.target.files)} />
            </div>
            {msg[kind] && <div className="login-error" style={{ marginBottom: 8 }}>{msg[kind]}</div>}
            {items.length === 0 ? (
              <div className="ledger-note">None yet.</div>
            ) : (
              <div className={kind === 'endcard' || kind === 'logo' ? 'kit-grid' : 'kit-list'}>
                {items.map((a, i) => (
                  <div className="kit-item" key={a.id}>
                    {kind === 'endcard' && <img className="kit-endcard" src={a.url} alt="" loading="lazy" />}
                    {kind === 'logo' && <div className="kit-logo"><img src={a.url} alt="" loading="lazy" /></div>}
                    {kind === 'font' && (
                      <div className="kit-font" style={{ fontFamily: '"' + kitFontFamily(a.id) + '", sans-serif' }}>
                        New drop for {brandName}
                      </div>
                    )}
                    {kind === 'music' && <audio className="kit-audio" src={a.url} controls preload="none" />}
                    <div className="kit-meta">
                      {editing && editing.id === a.id ? (
                        <form onSubmit={(e) => { e.preventDefault(); run(kind, { action: 'rename', id: a.id, name: editing.name }); }}>
                          <input className="input" autoFocus value={editing.name} onChange={(e) => setEditing({ id: a.id, name: e.target.value })}
                            onBlur={() => setEditing(null)} />
                        </form>
                      ) : (
                        <button type="button" className="link-inline kit-name" title="Rename" onClick={() => setEditing({ id: a.id, name: a.name })}>{a.name}</button>
                      )}
                      <div className="li-sub">
                        {i === 0 ? 'Default · ' : ''}
                        {a.meta.width ? a.meta.width + 'x' + a.meta.height + ' · ' : ''}
                        {a.meta.seconds ? Math.round(a.meta.seconds) + 's · ' : ''}
                        {kind === 'music' ? (a.meta.bpm ? a.meta.bpm + ' BPM · ' : 'no clear beat · ') : ''}
                        {a.size ? mb(a.size) : ''}
                      </div>
                      <div className="kit-actions">
                        {i > 0 && <button type="button" className="link-inline" onClick={() => run(kind, { action: 'default', id: a.id })}>Make default</button>}
                        <button type="button" className="link-inline" onClick={() => run(kind, { action: 'delete', id: a.id },
                          'Delete ' + a.name + ' from the ' + brandName + ' kit? Videos already sent to Meta keep it; new ones cannot use it.')}>Delete</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
