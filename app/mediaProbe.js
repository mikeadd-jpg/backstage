'use client';
// Reads what the browser can tell about a picked file before it is used or uploaded:
// image and video size, a small JPEG thumbnail, a song's length and tempo. Shared by the
// video builder (app/AdStudio.jsx) and the brand kit in Settings (app/BrandKit.jsx).
import { detectTempo } from '../lib/adPlans.js';

// A small JPEG of an image or a video frame: shown in the list, and sent to Claude so it
// can see the shots. Never the full file.
export function thumbOf(el, w, h) {
  const scale = Math.min(1, 512 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.72);
  return { url, mediaType: 'image/jpeg', data: url.split(',')[1] };
}

export function probeImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight, thumb: thumbOf(img, img.naturalWidth, img.naturalHeight) });
    img.onerror = () => reject(new Error('That image could not be read.'));
    img.src = src;
  });
}

export function probeVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => resolve({ width: v.videoWidth, height: v.videoHeight, seconds: v.duration, thumb: thumbOf(v, v.videoWidth, v.videoHeight) });
    v.onerror = () => reject(new Error('That video could not be read. MP4 (H.264) and MOV from a phone are safest.'));
    v.src = src;
  });
}

export async function probeAudio(file) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const beat = detectTempo(buf.getChannelData(0), buf.sampleRate);
    return { seconds: buf.duration, beat };
  } catch {
    throw new Error('That audio file could not be read. MP3, M4A or WAV work.');
  } finally {
    ctx.close();
  }
}

// A kit image as a blob: URL the video renderer can draw. SVGs are drawn once onto a
// canvas at `size` px on the long edge and handed over as PNG: the renderer skipped SVG
// files loaded by URL (it promises only inline SVG), and an SVG's 150px default size
// would come out soft anyway. Returns { src, width, height }.
// How light an image's visible pixels are, 0 (black) to 1 (white), ignoring transparent
// ones: tells a light logo from a dark one, so each layout can pick the one that shows.
export async function inkLightness(src) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
  return n ? sum / n : 0.5;
}

export async function renderableImage(blob, size = 1600) {
  if (blob.type !== 'image/svg+xml') {
    const src = URL.createObjectURL(blob);
    return { src, ...(await probeImage(src).then(({ width, height }) => ({ width, height })).catch(() => ({}))) };
  }
  const svgUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That SVG could not be read.'));
      i.src = svgUrl;
    });
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    const w = Math.round(ratio >= 1 ? size : size * ratio), h = Math.round(ratio >= 1 ? size / ratio : size);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { src: URL.createObjectURL(png), width: w, height: h };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// The textures behind the video looks (VHS, old movie, grainy...), drawn once per tab in
// the browser and handed to the templates as blob: URLs, so nothing is stored or fetched:
// four frames of grey noise (cycled per frame for moving static), scanlines, a vignette,
// two old film scratches and three frames of dust. Sized for a 9:16 frame; the templates stretch them to any shape.
let fxPromise = null;
export function fxTextures() {
  if (fxPromise) return fxPromise;
  const toUrl = (c) => new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b)), 'image/png'));
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
  fxPromise = (async () => {
    const noise = [];
    for (let n = 0; n < 4; n++) {
      const [c, g] = canvas(540, 960);
      const img = g.createImageData(540, 960);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      noise.push(await toUrl(c));
    }
    const [sc, sg] = canvas(8, 1920);
    for (let y = 0; y < 1920; y += 4) { sg.fillStyle = 'rgba(0,0,0,0.85)'; sg.fillRect(0, y, 8, 2); }
    const [vc, vg] = canvas(540, 960);
    const grad = vg.createRadialGradient(270, 480, 160, 270, 480, 620);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.95)');
    vg.fillStyle = grad; vg.fillRect(0, 0, 540, 960);
    const scratches = [];
    for (let n = 0; n < 2; n++) {
      const [c, g] = canvas(540, 960);
      g.strokeStyle = 'rgba(235,230,215,0.9)'; g.lineWidth = n ? 1.2 : 2;
      g.beginPath(); let x = 8 + n * 4; g.moveTo(x, 0);
      for (let y = 0; y <= 960; y += 40) { x += (Math.random() - 0.5) * 3; g.lineTo(x, y); }
      g.stroke();
      for (let d = 0; d < 14; d++) { g.fillStyle = 'rgba(235,230,215,0.8)'; g.fillRect(Math.random() * 540, Math.random() * 960, 2 + Math.random() * 3, 2 + Math.random() * 3); }
      scratches.push(await toUrl(c));
    }
    // Dust: specks and short hairs, three frames picked at random every other frame.
    const dust = [];
    for (let n = 0; n < 3; n++) {
      const [c, g] = canvas(540, 960);
      g.fillStyle = 'rgba(240,235,220,0.9)'; g.strokeStyle = 'rgba(240,235,220,0.8)';
      for (let d = 0; d < 26; d++) { const r = 0.6 + Math.random() * 2.2; g.beginPath(); g.arc(Math.random() * 540, Math.random() * 960, r, 0, 7); g.fill(); }
      for (let h = 0; h < 3; h++) {
        let x = Math.random() * 540, y = Math.random() * 960; g.lineWidth = 0.8; g.beginPath(); g.moveTo(x, y);
        for (let k = 0; k < 5; k++) { x += (Math.random() - 0.5) * 18; y += (Math.random() - 0.3) * 14; g.lineTo(x, y); }
        g.stroke();
      }
      dust.push(await toUrl(c));
    }
    return { noise, scanlines: await toUrl(sc), vignette: await toUrl(vc), scratches, dust };
  })();
  return fxPromise;
}
