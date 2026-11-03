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
