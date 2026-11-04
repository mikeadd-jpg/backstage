'use client';
// Competitors' running Meta ads, fetched daily by Backstage (lib/adLibrary.js) with our own
// saved copies of their images and videos, plus screenshots and screen recordings sent
// from a phone. Pick one and Claude says what it is doing and how to build our own
// version; "Make one like it" hands Claude's scene to the Mockups tab, where our real
// product is shot in it and reviewed like any other mockup. Breakdowns are held in this
// tab only; stars, notes, captures and the competitor list are saved.
import { useEffect, useMemo, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import Batches from './Batches.jsx';

const PAGE = 60;
const SEED_KEY = 'backstage.mockupSeed'; // read once by app/Mockups.jsx
const TOOL_LABELS = { mockup: 'Lifestyle mockup', image: 'Static image ad (Image builder)', carousel: 'Carousel ad', video: 'Video ad (Video builder)' };
const CAPTURE_PREFIX = 'inspiration/captures/';

// "Likely winner": Meta publishes no impressions for US commercial ads, but the Ad
// Library ranks each advertiser's running ads by impressions, and that rank is saved on
// every fetch. An ad near the top of its advertiser's list, live for a month, or run as
// several versions is one they keep paying for. Still an inference, and the tab says so.
const WIN_RANK = 3;       // in the advertiser's top three by impressions
const WIN_DAYS = 30;      // or still live after a month
const WIN_COPIES = 3;     // or running as three or more versions
const COPY_CAP = 10;      // some advertisers launch 30+ copies on day one; that is setup, not proof

function score(a) {
  if (!a.active) return -1;
  const rankPts = a.rank ? Math.max(0, 60 - (a.rank - 1) * 6) : 0;
  return rankPts + a.days + 10 * Math.min(Math.max(0, a.copies - 1), COPY_CAP);
}

// Same advertiser, same headline once case, spacing and punctuation are ignored, so
// fifteen copies of one ad show as one card. Ads with no headline stand alone.
function copyKey(ad) {
  const h = String(ad.headline || '').toLowerCase().replace(/[^\p{L}\p{N}$%]+/gu, ' ').trim();
  return h ? ad.competitor + '|' + h : 'id|' + ad.id;
}

// Screenshots go to Claude, which reads nothing past ~1568px on the long edge, so shrink
// before sending rather than paying to upload pixels nobody looks at.
function shrinkCanvas(source, w, h) {
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(shrinkCanvas(img, img.width, img.height)); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

// A frame about a second into a recording, as a JPEG data URL, for Claude to read the
// advertiser from. Our Blob copies send CORS headers, so the canvas stays readable.
function frameOf(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.muted = true; v.playsInline = true; v.preload = 'auto';
    const done = (fn) => { clearTimeout(t); v.removeAttribute('src'); v.load(); fn(); };
    const t = setTimeout(() => done(() => reject(new Error('timeout'))), 20000);
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      try { const d = shrinkCanvas(v, v.videoWidth, v.videoHeight); done(() => resolve(d)); }
      catch (e) { done(() => reject(e)); }
    };
    v.onerror = () => done(() => reject(new Error('unreadable')));
    v.src = url;
  });
}

async function post(body) {
  const res = await fetch('/api/inspiration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Request failed.');
  return d;
}

const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
};

// The ad's own picture: our saved copy, a video with its poster, or nothing yet.
function Media({ media, big, videoRef }) {
  const v = media.find((m) => m.kind === 'video');
  const img = media.find((m) => m.kind === 'image');
  if (v) {
    return big
      ? <video ref={videoRef} className="insp-media" src={v.url} poster={v.poster || undefined} controls playsInline crossOrigin="anonymous" preload="metadata" />
      : <div className="insp-media-wrap">{v.poster ? <img className="insp-media" src={v.poster} alt="" loading="lazy" /> : <div className="insp-media insp-media-none" />}<span className="insp-play">&#9654;</span></div>;
  }
  if (img) return <img className="insp-media" src={img.url} alt="" loading="lazy" />;
  return null;
}

// "Pick" adds a card to the batch in the bar at the bottom (Recreate, lib/recreate.js).
function PickButton({ picked, onPick }) {
  if (!onPick) return null;
  return (
    <button type="button" className={'insp-pick' + (picked ? ' on' : '')} onClick={onPick} aria-pressed={picked}
      title="Pick it to recreate with our products and brand kit">{picked ? '✓ Picked' : 'Pick'}</button>
  );
}

function AdCard({ ad, open, onOpen, onStar, picked, onPick }) {
  return (
    <div className={'card insp-ad' + (open ? ' open' : '') + (picked ? ' picked' : '')}>
      {!open && ad.media.length > 0 && <Media media={ad.media} />}
      <div className="insp-ad-top">
        <span className="insp-comp">{ad.competitor}</span>
        <button type="button" className={'insp-star-btn' + (ad.starred ? ' on' : '')} onClick={onStar} title={ad.starred ? 'Unstar' : 'Star'}>
          {ad.starred ? '★' : '☆'}
        </button>
        <PickButton picked={picked} onPick={onPick} />
        {ad.winner && (
          <span className="insp-win" title="Likely winner: in the advertiser's top 3 by impressions, live for a month, or run as several versions. Inferred, since Meta does not publish impressions for these ads.">
            Likely winner
          </span>
        )}
        <span className={'insp-run' + (ad.active ? '' : ' ended')}>
          {ad.active
            ? (ad.rank ? '#' + ad.rank + ' · ' : '') + (ad.copies > 1 ? ad.copies + ' versions · ' : '') + (ad.days > 0 ? ad.days + 'd' : 'new')
            : 'ended'}
        </span>
      </div>
      {ad.headline && <div className="insp-headline">{ad.headline}</div>}
      {ad.text && <div className="insp-text">{ad.text}</div>}
      {ad.notes && <div className="insp-notes">Note: {ad.notes}</div>}
      <div className="insp-meta">
        {ad.format ? ad.format.toLowerCase() + ' · ' : ''}Started {ad.startDate || '?'} · seen {ad.firstSeen}{ad.lastSeen && ad.lastSeen !== ad.firstSeen ? ' to ' + ad.lastSeen : ''}
        {!ad.mediaSaved && ad.active ? ' · picture not saved yet' : ''}
      </div>
      <div className="reply-actions insp-actions">
        <a className="btn btn-ghost" href={ad.url} target="_blank" rel="noreferrer">Ad Library</a>
        <button className={'btn ' + (open ? 'btn-ghost' : 'btn-primary')} onClick={onOpen}>
          {open ? 'Close' : 'How would I build this?'}
        </button>
      </div>
    </div>
  );
}

function CaptureCard({ cap, open, onOpen, onStar, onDelete, picked, onPick }) {
  return (
    <div className={'card insp-ad' + (open ? ' open' : '') + (picked ? ' picked' : '')}>
      {!open && (cap.kind === 'video'
        ? <video className="insp-media" src={cap.url + '#t=0.5'} muted playsInline preload="metadata" />
        : <img className="insp-media" src={cap.url} alt="" loading="lazy" />)}
      <div className="insp-ad-top">
        <span className="insp-comp">{cap.competitor || 'Unlabelled'}</span>
        <button type="button" className={'insp-star-btn' + (cap.starred ? ' on' : '')} onClick={onStar} title={cap.starred ? 'Unstar' : 'Star'}>
          {cap.starred ? '★' : '☆'}
        </button>
        <PickButton picked={picked} onPick={onPick} />
        <span className="insp-run">{cap.reading ? 'reading...' : (cap.info && cap.info.platform && cap.info.platform !== 'unknown' ? cap.info.platform + ' · ' : '') + (cap.kind === 'video' ? 'recording' : 'screenshot')}</span>
      </div>
      {cap.info && cap.info.headline && <div className="insp-headline">{cap.info.headline}</div>}
      {cap.info && cap.info.text && <div className="insp-text">{cap.info.text}</div>}
      {cap.note && <div className="insp-notes">{cap.note}</div>}
      <div className="insp-meta">{cap.source === 'shortcut' ? 'From the iPhone Shortcut' : 'Uploaded' + (cap.by ? ' by ' + cap.by.split('@')[0] : '')} · {ago(cap.at)}</div>
      <div className="reply-actions insp-actions">
        <button className={'btn ' + (open ? 'btn-ghost' : 'btn-primary')} onClick={onOpen}>{open ? 'Close' : 'How would I build this?'}</button>
        <button className="btn btn-ghost" type="button" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

// The breakdown panel, for an ad or a capture. An ad's saved picture (or a video's poster)
// goes to Claude automatically; a screenshot can still be added for ads without one, and
// a recording needs a frame picked from it.
function Breakdown({ item, isCapture, brands, brand, setBrand, state, setState, go, onSaved }) {
  const { image = '', recipe = null, busy = false, error = '', scene = '' } = state;
  const brandName = (brands.find((b) => b.key === brand) || {}).name || brand;
  const videoRef = useRef(null);
  const media = isCapture ? [{ kind: item.kind, url: item.url }] : item.media;
  const hasPicture = isCapture ? item.kind === 'image' : media.some((m) => m.kind === 'image' || m.poster);
  const isVideo = media.some((m) => m.kind === 'video');
  const [note, setNote] = useState(isCapture ? item.note : item.notes);
  const [label, setLabel] = useState(isCapture ? item.competitor : '');

  async function pick(file) {
    if (!file || !file.type.startsWith('image/')) return;
    try { setState({ image: await shrink(file), error: '' }); }
    catch (e) { setState({ error: e.message }); }
  }
  function onPaste(e) {
    const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (it) { e.preventDefault(); pick(it.getAsFile()); }
  }
  // The frame showing in the player, for Claude to read. Our Blob copies send CORS
  // headers, so the canvas stays readable.
  function grabFrame() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return setState({ error: 'Play the recording to the moment you want, then grab it.' });
    try { setState({ image: shrinkCanvas(v, v.videoWidth, v.videoHeight), error: '' }); }
    catch { setState({ error: 'Could not read that frame.' }); }
  }

  async function analyze() {
    setState({ busy: true, error: '' });
    try {
      const d = await post({ action: 'analyze', brand, image: image || undefined, ...(isCapture ? { captureId: item.id } : { adId: item.id }) });
      setState({ busy: false, recipe: d.recipe, scene: d.recipe.scene, recipeBrand: brand });
    } catch (e) {
      setState({ busy: false, error: e.message });
    }
  }

  async function saveNote() {
    try {
      await post(isCapture ? { action: 'mark-capture', id: item.id, note, competitor: label } : { action: 'mark-ad', id: item.id, notes: note });
      onSaved();
    } catch (e) { setState({ error: e.message }); }
  }

  function makeOne() {
    try {
      sessionStorage.setItem(SEED_KEY, JSON.stringify({
        brand: state.recipeBrand || brand, scene, search: recipe.product || '',
        source: (isCapture ? (item.competitor || 'Phone capture') : item.competitor + ': ' + (item.headline || 'ad ' + item.id)).slice(0, 140),
      }));
    } catch {}
    go('mockups');
  }

  return (
    <div className="card insp-detail" onPaste={onPaste}>
      {media.length > 0 && (
        <div className="insp-big">
          {isCapture && item.kind === 'image' ? <img className="insp-media" src={item.url} alt="" /> : <Media media={media} big videoRef={videoRef} />}
          {isVideo && <button type="button" className="btn btn-ghost" onClick={grabFrame}>Use this frame for Claude</button>}
        </div>
      )}
      <div className="field-row">
        <label className="field">
          <span>Our store to adapt it for</span>
          <select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>
            {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
          </select>
        </label>
        {isCapture && (
          <label className="field">
            <span>Whose ad is it?</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Vans" />
          </label>
        )}
      </div>
      <label className="field">
        <span>Note</span>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what caught your eye" />
      </label>
      <div className="reply-actions" style={{ marginTop: -4, marginBottom: 10 }}>
        <button className="btn btn-ghost" type="button" onClick={saveNote}>Save note</button>
      </div>

      {(image || (!hasPicture && !isVideo)) && (
        <div
          className={'insp-drop' + (image ? ' has' : '')}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }}
        >
          {image ? (
            <>
              <img src={image} alt="What Claude will see" />
              <button className="btn btn-ghost" onClick={() => setState({ image: '' })}>Remove</button>
            </>
          ) : (
            <>
              <span>No picture of this ad is saved yet. Paste, drop or choose a screenshot, or Claude has only the text.</span>
              <label className="btn btn-ghost">
                Choose image
                <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files[0])} />
              </label>
            </>
          )}
        </div>
      )}

      {error && <div className="login-error">{error}</div>}
      <div className="reply-actions" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={analyze} disabled={busy || !brand || (isCapture && item.kind === 'video' && !image)}>
          {busy ? 'Reading the ad...' : recipe ? 'Break it down again' : 'Break it down for ' + brandName}
        </button>
        {isCapture && item.kind === 'video' && !image && <span className="ledger-note">Pick a frame first.</span>}
      </div>

      {recipe && (
        <div className="insp-recipe">
          <dl className="insp-facts">
            <dt>Format</dt><dd>{recipe.format || 'unknown'}</dd>
            <dt>Hook</dt><dd>{recipe.hook}</dd>
            <dt>Why it works</dt><dd>{recipe.why}</dd>
          </dl>
          <div className="insp-sub">Build it as: {TOOL_LABELS[recipe.tool] || recipe.tool}</div>
          <p className="insp-p">{recipe.toolWhy}</p>
          <ol className="insp-steps">{recipe.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {recipe.headlines.length > 0 && (
            <>
              <div className="insp-sub">Headline ideas</div>
              <ul className="insp-steps">{recipe.headlines.map((h, i) => <li key={i}>{h}</li>)}</ul>
            </>
          )}
          <div className="insp-sub">Don't copy</div>
          <p className="insp-p">{recipe.avoid}</p>
          <label className="field" style={{ marginTop: 6 }}>
            <span>Scene for Mockups{recipe.product ? ' · use a product like: ' + recipe.product : ''}</span>
            <textarea className="input" rows={5} value={scene} onChange={(e) => setState({ scene: e.target.value })} />
          </label>
          <div className="reply-actions">
            <button className="btn btn-primary" onClick={makeOne} disabled={!scene.trim()}>Make one like it in Mockups</button>
            {recipe.tool !== 'mockup' && <button className="btn btn-ghost" onClick={() => go('ads')}>Open Ads</button>}
          </div>
          <div className="ledger-note" style={{ marginTop: 8 }}>
            Mockups opens on {(brands.find((b) => b.key === (state.recipeBrand || brand)) || {}).name || 'that store'} with this scene ready for the next products you pick. Nothing is generated until you press Generate there.
          </div>
        </div>
      )}
    </div>
  );
}

// Upload from this device (on a phone, the camera roll), straight to storage, then
// recorded. Several at once; each keeps its own error.
function AddCaptures({ competitors, onDone }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const input = useRef(null);
  async function add(files) {
    setErr('');
    const list = [...files];
    const errors = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setBusy('Uploading ' + (i + 1) + ' of ' + list.length + '...');
      try {
        if (!/^(image|video)\//.test(f.type)) throw new Error(f.name + ' is not an image or video.');
        const safe = f.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').slice(-60) || 'capture';
        const blob = await upload(CAPTURE_PREFIX + new Date().toISOString().slice(0, 10) + '-' + safe, f, {
          access: 'public', handleUploadUrl: '/api/inspiration/upload', contentType: f.type, multipart: f.size > 8 * 1024 * 1024,
        });
        await post({ action: 'add-capture', url: blob.url, competitor: label, note });
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }
    setBusy(''); setErr(errors.join(' '));
    if (input.current) input.current.value = '';
    if (errors.length < list.length) { setNote(''); onDone(); }
  }
  return (
    <div className="card">
      <div className="card-label">Add screenshots or recordings</div>
      <div className="field-row">
        <label className="field">
          <span>Whose ads (optional)</span>
          <input className="input" list="insp-comp-names" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Vans" />
          <datalist id="insp-comp-names">{competitors.map((c) => <option key={c.id} value={c.name} />)}</datalist>
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what caught your eye" />
        </label>
      </div>
      <div className="reply-actions">
        <button className="btn btn-primary" type="button" disabled={Boolean(busy)} onClick={() => input.current && input.current.click()}>
          {busy || '+ Choose from this device'}
        </button>
        <input ref={input} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => add(e.target.files)} />
        <span className="ledger-note">On a phone this opens your photos, recordings included.</span>
      </div>
      {err && <div className="login-error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

// How to set up the iPhone Shortcut, with its private key made here and shown once.
function ShortcutSetup({ info, canMake, onMade }) {
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const endpoint = typeof window !== 'undefined' ? window.location.origin + '/api/inspiration/capture' : '/api/inspiration/capture';
  async function make() {
    if (info && !window.confirm('Make a new key? The old one stops working, so the Shortcut needs the new one.')) return;
    setErr('');
    try { const d = await post({ action: 'upload-key' }); setKey(d.key); onMade(); }
    catch (e) { setErr(e.message); }
  }
  return (
    <details className="card insp-shortcut">
      <summary className="card-label" style={{ cursor: 'pointer' }}>iPhone Share button setup</summary>
      <p className="pane-sub" style={{ marginTop: 6 }}>
        A Shortcut in the Share sheet sends a screenshot or screen recording here in two taps: in Photos, tap Share, then
        Send to Backstage. It goes straight to storage, so long recordings are fine, and shows up in this tab the next time it loads.
      </p>
      <div className="reply-actions" style={{ marginBottom: 10 }}>
        {canMake ? <button className="btn btn-ghost" type="button" onClick={make}>{info ? 'Make a new key' : 'Make the Shortcut key'}</button>
          : <span className="ledger-note">An owner or admin makes the key.</span>}
        {info && !key && <span className="ledger-note">A key exists, made by {String(info.by || '').split('@')[0]} {ago(info.at)}.</span>}
      </div>
      {key && (
        <div className="flag ok" style={{ marginBottom: 10 }}>
          <span className="ico">&#10003;</span>
          <span>
            Your key, shown only now: <code className="insp-key">{key}</code>{' '}
            <button type="button" className="link-inline" onClick={() => navigator.clipboard && navigator.clipboard.writeText(key)}>Copy</button>
            <br />Put it in the Shortcut below. Anyone with it can add captures, nothing else.
          </span>
        </div>
      )}
      {err && <div className="login-error" style={{ marginBottom: 10 }}>{err}</div>}
      <ol className="insp-steps">
        <li>Open the Shortcuts app, tap +, and name the shortcut <b>Send to Backstage</b>.</li>
        <li>Tap the (i) info button, turn on <b>Show in Share Sheet</b>, and set it to receive <b>Images</b> and <b>Media</b>.</li>
        <li>Add <b>Get Contents of URL</b>. URL: <code>{endpoint}</code>. Method: <b>POST</b>. Headers: <code>Authorization</code> = <code>Bearer YOUR-KEY</code>. Request Body: <b>JSON</b>, with <code>name</code> = <b>Shortcut Input</b> → <b>Name</b>, and <code>ext</code> = <b>Shortcut Input</b> → <b>File Extension</b>.</li>
        <li>Add <b>Get Dictionary Value</b>: get the value for <code>uploadUrl</code> in Contents of URL.</li>
        <li>Add a second <b>Get Contents of URL</b>. URL: the Dictionary Value. Method: <b>PUT</b>. Request Body: <b>File</b>, set to <b>Shortcut Input</b>.</li>
        <li>Optional: add <b>Show Notification</b> "Sent to Backstage".</li>
      </ol>
      <div className="ledger-note">Photos taken with the camera (HEIC) may not show in every browser; screenshots and screen recordings always do. To be safe, add <b>Convert Image</b> to JPEG before step 3 for photos.</div>
    </details>
  );
}

// Which of our stores a competitor matters for: none ticked means all of them.
function StorePicks({ brands, value, onChange }) {
  return (
    <span className="insp-stores">
      {brands.map((b) => {
        const on = value.includes(b.key);
        return (
          <button key={b.key} type="button" className={'insp-store' + (on ? ' on' : '')}
            onClick={() => onChange(on ? value.filter((x) => x !== b.key) : [...value, b.key])}>{b.name}</button>
        );
      })}
      {!value.length && <span className="li-sub">all stores</span>}
    </span>
  );
}

function Competitors({ list, brands, onChanged }) {
  const [name, setName] = useState('');
  const [page, setPage] = useState('');
  const [picks, setPicks] = useState([]);
  const [err, setErr] = useState('');
  const [scanning, setScanning] = useState({});   // id -> message
  async function act(body) {
    setErr('');
    try { const d = await post(body); onChanged(); return d; } catch (e) { setErr(e.message); return null; }
  }
  // Fetch one competitor's running ads and save their pictures now, rather than waiting
  // for the morning run. Takes a minute or two for a big advertiser.
  async function scan(id) {
    setScanning((s) => ({ ...s, [id]: 'Scanning their Ad Library...' }));
    try {
      const r = await post({ action: 'scan-competitor', id });
      setScanning((s) => ({ ...s, [id]: r.errors && r.errors.length ? r.errors.join(' ') : r.newAds + ' new ads, ' + r.mediaSaved + ' pictures saved' }));
    } catch (e) {
      setScanning((s) => ({ ...s, [id]: e.message }));
    }
    onChanged();
  }
  // Paste an Ad Library link and the Page id is read out of it.
  const idOf = (v) => (/view_all_page_id=(\d+)/.exec(v) || [])[1] || String(v || '').trim();
  const pageId = idOf(page);
  // Competitors found on phone captures arrive without a Page: a link pasted here adds it
  // and scans them straight away.
  const [links, setLinks] = useState({});      // id -> pasted link
  async function addLink(c) {
    const d = await act({ action: 'save-competitor', id: c.id, pageId: idOf(links[c.id]) });
    if (d) { setLinks((l) => ({ ...l, [c.id]: '' })); scan(c.id); }
  }
  const searchUrl = (name) => 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&search_type=keyword_unordered&q=' + encodeURIComponent(name);
  const needLink = list.filter((c) => !c.pageId).length;
  return (
    <div className="card">
      <div className="card-label">Competitors</div>
      <p className="pane-sub" style={{ marginTop: 0 }}>
        Backstage reads each active competitor's running ads every morning, and straight away when you add one. Tick the
        stores each one matters for (none ticked means all). Removing one stops the reading; its ads stay. Brands read off
        your phone captures are added here too, waiting for their Ad Library link.
      </p>
      {needLink > 0 && <div className="ledger-note" style={{ marginBottom: 10 }}>{needLink} found on your phone captures {needLink === 1 ? 'needs its' : 'need their'} Ad Library link.</div>}
      <div className="insp-comp-list">
        {list.map((c) => (
          <div key={c.id} className="insp-comp-row">
            <label className="check" title={c.active ? 'Fetched daily' : 'Paused'}>
              <input type="checkbox" checked={c.active} onChange={(e) => act({ action: 'save-competitor', id: c.id, active: e.target.checked })} />
            </label>
            <div className="insp-comp-name">
              <div className="li-name">{c.name}</div>
              {c.pageId ? (
                <div className="li-sub">
                  Page {c.pageId} · checked {ago(c.checkedAt)}{c.capped ? ' · more ads than one run reads' : ''}
                  {c.error && <span className="insp-err"> · {c.error}</span>}
                </div>
              ) : (
                <div className="insp-need-link">
                  <div className="li-sub">Found on a phone capture. <a href={searchUrl(c.name)} target="_blank" rel="noreferrer">Find them in the Ad Library</a>, open their Page's ads and paste the link:</div>
                  <div className="insp-link-row">
                    <input className="input" value={links[c.id] || ''} onChange={(e) => setLinks((l) => ({ ...l, [c.id]: e.target.value }))} placeholder="view_all_page_id=..." />
                    <button type="button" className="btn btn-ghost" disabled={!/^\d{5,25}$/.test(idOf(links[c.id]))} onClick={() => addLink(c)}>Add and scan</button>
                  </div>
                </div>
              )}
              <StorePicks brands={brands} value={c.brands || []} onChange={(v) => act({ action: 'save-competitor', id: c.id, brands: v })} />
              {scanning[c.id] && <div className="li-sub" style={{ marginTop: 4 }}>{scanning[c.id]}</div>}
            </div>
            {c.pageId && <button type="button" className="link-inline" disabled={scanning[c.id] === 'Scanning their Ad Library...'} onClick={() => scan(c.id)}>Scan now</button>}
            {c.pageId && <a className="link-inline" href={'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=' + c.pageId} target="_blank" rel="noreferrer">Ad Library</a>}
            <button type="button" className="link-inline" onClick={() => window.confirm('Stop following ' + c.name + '? Their saved ads stay.') && act({ action: 'remove-competitor', id: c.id })}>Remove</button>
          </div>
        ))}
        {list.length === 0 && <div className="ledger-note">No competitors yet.</div>}
      </div>
      <div className="field-row" style={{ marginTop: 12 }}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Vans" /></label>
        <label className="field"><span>Page ID or Ad Library link</span><input className="input" value={page} onChange={(e) => setPage(e.target.value)} placeholder="view_all_page_id=..." /></label>
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <span>Applies to</span>
        <StorePicks brands={brands} value={picks} onChange={setPicks} />
      </div>
      <div className="reply-actions">
        <button className="btn btn-ghost" type="button" disabled={!name.trim() || !pageId}
          onClick={async () => {
            const d = await act({ action: 'save-competitor', name, pageId, brands: picks });
            if (d && d.id) { setName(''); setPage(''); setPicks([]); scan(d.id); }
          }}>Add and scan</button>
        <span className="ledger-note">Open the brand in the Meta Ad Library and paste the page's link.</span>
      </div>
      {err && <div className="login-error" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

export default function Inspiration({ go }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState('');
  const [brands, setBrands] = useState([]);
  const [brand, setBrand] = useState('');

  const [view, setView] = useState('ads');           // ads | captures | competitors
  const [competitor, setCompetitor] = useState('');
  const [store, setStore] = useState('');             // '' = every store
  const [show, setShow] = useState('active');        // active | all | starred
  const [sort, setSort] = useState('winners');       // winners | newest | longest
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const [openId, setOpenId] = useState(null);
  const [states, setStates] = useState({});          // item key -> breakdown state, this tab only

  // Picked ads and captures for a Recreate batch (lib/recreate.js), and its options.
  const [picked, setPicked] = useState({});           // key -> { type, id, label }
  const [rc, setRc] = useState({ store: '', make: 'auto', perAd: 2, aspect: '', notes: '' });
  const [rcBusy, setRcBusy] = useState(false);
  const [rcError, setRcError] = useState('');
  const [batchRefresh, setBatchRefresh] = useState(0);
  const pickedList = Object.values(picked);
  const togglePick = (k, item) => setPicked((p) => {
    const next = { ...p };
    if (next[k]) delete next[k]; else next[k] = item;
    return next;
  });
  const rcStore = rc.store || store || brand;
  const rcTotal = pickedList.length * rc.perAd;
  async function startBatch() {
    setRcBusy(true); setRcError('');
    try {
      const res = await fetch('/api/recreate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', brand: rcStore, picks: pickedList.map(({ type, id }) => ({ type, id })), make: rc.make, perAd: rc.perAd, aspect: rc.aspect, notes: rc.notes }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not start the batch.');
      setPicked({}); setBatchRefresh((n) => n + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { setRcError(e.message); } finally { setRcBusy(false); }
  }

  function load() {
    setLoading(true); setError('');
    fetch('/api/inspiration')
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        setBrands(d.brands || []);
        setBrand((b) => b || (d.brands && d.brands[0] && d.brands[0].key) || '');
        if (!ok) setError(d.error || 'Could not load Inspiration.');
        else setData(d);
      })
      .catch(() => setError('Could not load Inspiration.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function fetchNow() {
    setRefreshing('Fetching competitors\' ads... this can take a few minutes.'); setError('');
    try {
      const r = await post({ action: 'refresh' });
      setRefreshing('');
      setError(r.errors && r.errors.length ? r.errors.join(' ') : '');
      load();
    } catch (e) { setRefreshing(''); setError(e.message); }
  }

  // Optimistic star, then reload quietly so everything agrees with the database.
  function star(kind, item) {
    setData((d) => ({ ...d, [kind === 'ad' ? 'ads' : 'captures']: d[kind === 'ad' ? 'ads' : 'captures'].map((x) => (x.id === item.id ? { ...x, starred: !x.starred } : x)) }));
    post(kind === 'ad' ? { action: 'mark-ad', id: item.id, starred: !item.starred } : { action: 'mark-capture', id: item.id, starred: !item.starred }).catch((e) => setError(e.message));
  }

  // Captures nobody has read yet are read in the background, two at a time: Claude names
  // the advertiser (filling the brand if it is blank) and the visible text. Recordings
  // send a frame from a second in. A failure leaves the capture for the next load.
  const reading = useRef(new Set());
  useEffect(() => {
    if (!data) return;
    const todo = data.captures.filter((c) => !c.read && !reading.current.has(c.id));
    if (!todo.length) return;
    todo.forEach((c) => reading.current.add(c.id));
    const patch = (id, p) => setData((d) => (d ? { ...d, captures: d.captures.map((x) => (x.id === id ? { ...x, ...p } : x)) } : d));
    let i = 0, added = false;
    const worker = async () => {
      while (i < todo.length) {
        const c = todo[i++];
        patch(c.id, { reading: true });
        try {
          const frame = c.kind === 'video' ? await frameOf(c.url).catch(() => null) : undefined;
          const r = await post({ action: 'read-capture', id: c.id, frame: frame || undefined });
          patch(c.id, { reading: false, read: true, competitor: r.competitor, info: r.info });
          if (r.addedCompetitor) added = true;
        } catch {
          patch(c.id, { reading: false });
        }
      }
    };
    // A brand read off a capture that was new to the list was added to Competitors.
    Promise.all([worker(), worker()]).then(() => { if (added) load(); });
  }, [data]);

  const ads = useMemo(() => (data ? data.ads : []).map((a) => {
    const key = copyKey(a);
    return { ...a, key, score: score(a), winner: a.active && ((a.rank && a.rank <= WIN_RANK) || a.days >= WIN_DAYS || a.copies >= WIN_COPIES) };
  }), [data]);
  // Which stores each competitor applies to, by name (captures carry only a name). A name
  // we do not follow, or a competitor with none ticked, counts for every store.
  const storesOf = useMemo(() => Object.fromEntries((data ? data.competitors : []).map((c) => [c.name.toLowerCase(), c.brands || []])), [data]);
  const forStore = (name) => { const b = storesOf[String(name || '').toLowerCase()]; return !store || !b || !b.length || b.includes(store); };
  const names = useMemo(() => Array.from(new Set(ads.map((a) => a.competitor))).sort((a, b) => a.localeCompare(b)), [ads]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = ads.filter((a) => {
      if (competitor && a.competitor !== competitor) return false;
      if (!forStore(a.competitor)) return false;
      if (show === 'active' && !a.active) return false;
      if (show === 'starred' && !a.starred) return false;
      if (q && !(a.headline + ' ' + a.text + ' ' + a.notes + ' ' + a.competitor).toLowerCase().includes(q)) return false;
      return true;
    });
    if (sort === 'winners') {
      const best = {};
      for (const a of list) if (a.winner && (!best[a.key] || a.score > best[a.key].score)) best[a.key] = a;
      return Object.values(best).sort((a, b) => b.score - a.score);
    }
    return list.sort(sort === 'longest'
      ? (a, b) => b.days - a.days || b.startDate.localeCompare(a.startDate)
      : (a, b) => b.startDate.localeCompare(a.startDate) || b.days - a.days);
  }, [ads, competitor, show, sort, search, store, storesOf]);
  const captures = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ? data.captures : []).filter((c) => (show !== 'starred' || c.starred) && forStore(c.competitor) &&
      (!q || [c.competitor, c.note, c.info && c.info.advertiser, c.info && c.info.headline, c.info && c.info.text].join(' ').toLowerCase().includes(q)));
  }, [data, show, search, store, storesOf]);
  useEffect(() => { setLimit(PAGE); }, [competitor, show, sort, search, view]);

  // A breakdown opens on the store being browsed, or the competitor's own store when it
  // applies to just some of ours.
  function openItem(k, name) {
    if (openId === k) return setOpenId(null);
    const b = storesOf[String(name || '').toLowerCase()] || [];
    if (store) setBrand(store);
    else if (b.length && !b.includes(brand)) setBrand(b[0]);
    setOpenId(k);
  }
  const setStateFor = (k) => (patch) => setStates((s) => ({ ...s, [k]: { ...(s[k] || {}), ...patch } }));
  const run = data && data.lastRun;

  return (
    <div className="pane insp-pane">
      <div className="pane-head">Inspiration</div>
      <p className="pane-sub">
        Competitors' running Meta ads, fetched every morning with their pictures saved, and anything you send from your phone.
        Pick one to see how we could make our own version.
      </p>

      {data && !data.configured && (
        <div className="flag" style={{ marginBottom: 14 }}>
          <span className="ico">&#9873;</span>
          <span>Fetching is off: SCRAPECREATORS_API_KEY is not set in Vercel. Ads already saved and phone captures still work.</span>
        </div>
      )}
      {error && <div className="flag" style={{ marginBottom: 14 }}><span className="ico">&#9873;</span><span>{error}</span></div>}

      <Batches refresh={batchRefresh} go={go} />

      <div className="pf-chips" role="tablist" aria-label="What to show" style={{ marginBottom: 12 }}>
        {[['ads', 'Competitor ads'], ['captures', 'From my phone' + (data && data.captures.length ? ' (' + data.captures.length + ')' : '')], ['competitors', 'Competitors']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={'chip' + (view === k ? ' active' : '')}
            onClick={() => { setView(k); setOpenId(null); }}>{l}</button>
        ))}
      </div>

      {view === 'competitors' && data && <Competitors list={data.competitors} brands={brands} onChanged={load} />}

      {view === 'captures' && data && (
        <>
          <AddCaptures competitors={data.competitors} onDone={load} />
          <ShortcutSetup info={data.uploadKey} canMake={data.canMakeKey} onMade={load} />
        </>
      )}

      {view !== 'competitors' && (
        <div className="card insp-filters">
          <div className="field-row">
            <label className="field">
              <span>For our store</span>
              <select className="input" value={store} onChange={(e) => { setStore(e.target.value); if (e.target.value) setBrand(e.target.value); }}>
                <option value="">All stores</option>
                {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select>
            </label>
            {view === 'ads' && (
              <label className="field">
                <span>Competitor</span>
                <select className="input" value={competitor} onChange={(e) => setCompetitor(e.target.value)}>
                  <option value="">All competitors</option>
                  {names.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label className="field">
              <span>Show</span>
              <select className="input" value={show} onChange={(e) => setShow(e.target.value)}>
                {view === 'ads' && <option value="active">Still running</option>}
                <option value={view === 'ads' ? 'all' : 'active'}>{view === 'ads' ? 'All, including ended' : 'All'}</option>
                <option value="starred">Starred</option>
              </select>
            </label>
            {view === 'ads' && (
              <label className="field">
                <span>Sort</span>
                <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="winners">Likely winners</option>
                  <option value="newest">Newest first</option>
                  <option value="longest">Running longest first</option>
                </select>
              </label>
            )}
            <label className="field">
              <span>Search</span>
              <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="headline, note or brand" />
            </label>
          </div>
          <div className="reply-actions" style={{ marginTop: -6 }}>
            <span className="acc-count">
              {loading ? 'loading...'
                : view === 'captures' ? captures.length + ' captures'
                : sort === 'winners'
                  ? filtered.length + ' likely winners, one card per set of copies. Ranked by Meta\'s own impressions order, days live and versions; Meta does not publish the numbers.'
                  : filtered.length + ' of ' + ads.length + ' ads'}
              {view === 'ads' && run && <> · last fetch {ago(run.finished_at || run.started_at)}, {run.new_ads} new{run.credits_left != null ? ', ' + run.credits_left + ' credits left' : ''}</>}
            </span>
            {view === 'ads' && data && data.configured && (
              <button className="btn btn-ghost" onClick={fetchNow} disabled={Boolean(refreshing)}>{refreshing ? 'Fetching...' : 'Fetch now'}</button>
            )}
            <button className="btn btn-ghost" onClick={load} disabled={loading}>Reload</button>
          </div>
          {refreshing && <div className="ledger-note">{refreshing}</div>}
        </div>
      )}

      {view === 'ads' && !loading && !error && filtered.length === 0 && (
        <div className="ledger-note mk-empty">No ads match. Ads are fetched each morning; check the filters or the competitor list.</div>
      )}
      {view === 'captures' && !loading && captures.length === 0 && (
        <div className="ledger-note mk-empty">Nothing from your phone yet. Upload above, or set up the iPhone Share button.</div>
      )}

      {view !== 'competitors' && (
        <div className="insp-grid">
          {view === 'ads' && filtered.slice(0, limit).map((ad) => {
            const k = 'a' + ad.id;
            return (
              <div key={k} className={openId === k ? 'insp-cell wide' : 'insp-cell'}>
                <AdCard ad={ad} open={openId === k} onOpen={() => openItem(k, ad.competitor)} onStar={() => star('ad', ad)}
                  picked={Boolean(picked[k])} onPick={() => togglePick(k, { type: 'ad', id: ad.id, label: ad.competitor })} />
                {openId === k && (
                  <Breakdown item={ad} brands={brands} brand={brand} setBrand={setBrand} state={states[k] || {}} setState={setStateFor(k)} go={go} onSaved={load} />
                )}
              </div>
            );
          })}
          {view === 'captures' && captures.slice(0, limit).map((cap) => {
            const k = 'c' + cap.id;
            return (
              <div key={k} className={openId === k ? 'insp-cell wide' : 'insp-cell'}>
                <CaptureCard cap={cap} open={openId === k} onOpen={() => openItem(k, cap.competitor)} onStar={() => star('capture', cap)}
                  picked={Boolean(picked[k])} onPick={() => togglePick(k, { type: 'capture', id: cap.id, label: cap.competitor || 'Capture' })}
                  onDelete={async () => {
                    if (!window.confirm('Delete this capture? The file is removed too.')) return;
                    try { await post({ action: 'delete-capture', id: cap.id }); if (openId === k) setOpenId(null); load(); } catch (e) { setError(e.message); }
                  }} />
                {openId === k && (
                  <Breakdown item={cap} isCapture brands={brands} brand={brand} setBrand={setBrand} state={states[k] || {}} setState={setStateFor(k)} go={go} onSaved={load} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {view !== 'competitors' && (view === 'ads' ? filtered.length : captures.length) > limit && (
        <div className="reply-actions" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-ghost" onClick={() => setLimit((n) => n + PAGE)}>Show more</button>
        </div>
      )}

      {pickedList.length > 0 && (
        <div className="card rc-bar">
          <div className="rc-bar-top">
            <span>Recreate {pickedList.length} ad{pickedList.length === 1 ? '' : 's'}</span>
            <span className="rc-sub acc-count">
              Our own version of each: {rcTotal} mockup{rcTotal === 1 ? '' : 's'} of our products from an original scene, then an ad from the brand kit, rendered and kept in Drafts.
              Their pictures and words are never reused.
            </span>
            <button className="btn btn-ghost" type="button" onClick={() => setPicked({})}>Clear</button>
          </div>
          <div className="field-row">
            <label className="field">
              <span>For</span>
              <select className="input" value={rcStore} onChange={(e) => setRc((o) => ({ ...o, store: e.target.value }))}>
                {brands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Make</span>
              <select className="input" value={rc.make} onChange={(e) => setRc((o) => ({ ...o, make: e.target.value }))}>
                <option value="auto">Claude picks per ad</option>
                <option value="image">Image ads</option>
                <option value="video">Video ads</option>
              </select>
            </label>
            <label className="field">
              <span>Mockups per ad</span>
              <select className="input" value={rc.perAd} onChange={(e) => setRc((o) => ({ ...o, perAd: Number(e.target.value) }))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Shape</span>
              <select className="input" value={rc.aspect} onChange={(e) => setRc((o) => ({ ...o, aspect: e.target.value }))}>
                <option value="">Videos 9:16, images 4:5</option>
                <option value="9:16">9:16 Reels and Stories</option>
                <option value="4:5">4:5 Feed</option>
                <option value="1:1">1:1 Square</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Notes for every ad (optional)</span>
            <input className="input" value={rc.notes} maxLength={600} onChange={(e) => setRc((o) => ({ ...o, notes: e.target.value }))}
              placeholder="e.g. push the new hoodies, keep it moody" />
          </label>
          {rcTotal > 20 && <div className="login-error" style={{ marginTop: 8 }}>A batch makes at most 20 mockups. Pick fewer ads or fewer mockups per ad.</div>}
          {rcError && <div className="login-error" style={{ marginTop: 8 }}>{rcError}</div>}
          <div className="reply-actions" style={{ marginTop: 8 }}>
            <button className="btn btn-primary" type="button" onClick={startBatch} disabled={rcBusy || rcTotal > 20 || pickedList.length > 10 || !rcStore}>
              {rcBusy ? 'Starting...' : 'Recreate ' + pickedList.length}
            </button>
            {pickedList.length > 10 && <span className="acc-count">Up to 10 ads per batch.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
