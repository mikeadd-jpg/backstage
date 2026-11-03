// Edit plans for the Ads tab's video builder: which asset is on screen for how long, what
// text goes over it, which song plays, and the end card. A plan is plain data, so the same
// shape comes from the three fixed templates (made here, instantly) and from Claude
// (lib/adVideo.js, checked by normalizePlan below before the tab ever sees it), and one
// Remotion composition (app/AdTemplates.jsx) renders either.
//
// Pure, no Node or React imports: the tab imports this, like lib/profitMath.js.

export const FPS = 30;

// Pieces of a rendered video sent to Meta per request (app/api/ads/video-upload).
export const CHUNK_BYTES = 4 * 1024 * 1024;

export const ASPECTS = {
  '9:16': { width: 1080, height: 1920, label: '9:16 Reels and Stories' },
  '4:5': { width: 1080, height: 1350, label: '4:5 Feed' },
  '1:1': { width: 1080, height: 1080, label: '1:1 Square' },
};

// Seconds per shot are clamped to each template's range, whoever wrote the plan.
export const TEMPLATES = {
  beat: {
    label: 'Quick cuts',
    about: 'Fast cuts landing on the beat of the song, a punch-in zoom and a flash on every cut, one or two bold words at a time.',
    min: 0.3, max: 1.6, seconds: 0.8, textMax: 28,
  },
  spotlight: {
    label: 'Product spotlight',
    about: 'One product at a time with a slow push-in, and a headline bar that slides up over each shot.',
    min: 1.5, max: 4.5, seconds: 2.5, textMax: 44,
  },
  story: {
    label: 'Slow story',
    about: 'Long crossfades and a gentle drift, with a short caption line that fades in per shot. Calm and moody.',
    min: 2.5, max: 6, seconds: 3.5, textMax: 70,
  },
};
export const TEMPLATE_KEYS = Object.keys(TEMPLATES);

export const END_SECONDS = 2.5;
export const MAX_SECONDS = 60;          // longer than any ad from here should be
export const MAX_SCENES = 40;
export const CROSSFADE = 15;            // frames, story template only

// Real colours, not the app's CSS vars: the renderer paints onto a canvas.
export const ACCENTS = { elderemo: '#6D28D9', poppunks: '#C6207A', wallspoke: '#1D5FD6' };

// Same rule as stripDashes in lib/classify.js: no em or en dashes in anything we publish.
export function noDashes(s) {
  return String(s == null ? '' : s)
    .replace(/(\d)\s*[—–]\s*(\d)/g, '$1 to $2')
    .replace(/(\w)\s*[—–]\s*(\w)/g, '$1, $2')
    .replace(/[—–]/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const clip = (s, n) => noDashes(s).slice(0, n).trim();
const round = (n) => Math.round(n * 100) / 100;

const isVisual = (a) => a && (a.kind === 'image' || a.kind === 'video');

/**
 * Make every plan safe to render: known template and aspect, only assets that exist,
 * shot lengths inside the template's range (and inside a video clip's own length), text
 * clipped, total under MAX_SECONDS. Unknown or empty input gives null.
 */
export function normalizePlan(raw, assets) {
  if (!raw || typeof raw !== 'object') return null;
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const template = TEMPLATE_KEYS.includes(raw.template) ? raw.template : 'spotlight';
  const t = TEMPLATES[template];
  const aspect = ASPECTS[raw.aspect] ? raw.aspect : '9:16';

  const scenes = [];
  let total = END_SECONDS;
  for (const s of Array.isArray(raw.scenes) ? raw.scenes : []) {
    const a = byId.get(String(s && s.asset));
    if (!isVisual(a)) continue;
    const from = a.kind === 'video' ? Math.max(0, Math.min(Number(s.from) || 0, Math.max(0, (a.seconds || 0) - t.min))) : 0;
    let seconds = Number(s.seconds) || t.seconds;
    seconds = Math.min(t.max, Math.max(t.min, seconds));
    if (a.kind === 'video' && a.seconds) seconds = Math.min(seconds, Math.max(0.3, a.seconds - from));
    if (total + seconds > MAX_SECONDS || scenes.length >= MAX_SCENES) break;
    total += seconds;
    scenes.push({ asset: a.id, seconds: round(seconds), from: round(from), text: clip(s.text, t.textMax) });
  }
  if (!scenes.length) return null;

  let audio = null;
  const au = raw.audio && byId.get(String(raw.audio.asset));
  if (au && au.kind === 'audio') {
    const from = Math.max(0, Math.min(Number(raw.audio.from) || 0, Math.max(0, (au.seconds || 0) - 1)));
    audio = { asset: au.id, from: round(from) };
  }

  const end = raw.end || {};
  return {
    template,
    aspect,
    title: clip(raw.title, 60) || t.label,
    why: clip(raw.why, 300),
    scenes,
    audio,
    end: { headline: clip(end.headline, 60), cta: clip(end.cta, 24) || 'Shop now' },
  };
}

// Frame timing for a plan. Story scenes overlap by CROSSFADE frames so each fades in over
// the one before; the others cut hard.
export function timeline(plan) {
  const overlap = plan.template === 'story' ? CROSSFADE : 0;
  let at = 0;
  const scenes = plan.scenes.map((s, i) => {
    const len = Math.max(1, Math.round(s.seconds * FPS));
    const start = Math.max(0, at - (i ? overlap : 0));
    at = start + len;
    return { ...s, start, frames: len, index: i };
  });
  const endFrames = Math.round(END_SECONDS * FPS);
  const endStart = Math.max(0, at - overlap);
  return { scenes, endStart, endFrames, total: endStart + endFrames, overlap };
}

export const planSeconds = (plan) => timeline(plan).total / FPS;

/**
 * The three fixed cuts from the assets in the order the person put them: no model call.
 * `beat` is detectTempo()'s answer for the first song, if there is one, so Quick cuts land
 * on the music. On-screen text is the product title where the asset has one; Claude's
 * plans are the way to get written copy.
 */
export function templatePlans(assets, { aspect = '9:16', beat = null, brandName = '' } = {}) {
  const visuals = (assets || []).filter(isVisual);
  if (!visuals.length) return [];
  const song = (assets || []).find((a) => a.kind === 'audio') || null;
  const titled = visuals.find((a) => a.title);
  const end = { headline: (visuals.length === 1 && titled ? titled.title : brandName) || brandName, cta: 'Shop now' };
  const audio = song ? { asset: song.id, from: beat && song.id === beat.asset ? beat.offset : 0 } : null;
  const titleOnce = new Set();
  const textFor = (a, n) => {
    if (!a.title || titleOnce.has(a.id)) return '';
    titleOnce.add(a.id);
    return a.title.slice(0, n);
  };

  // Quick cuts: one or two beats a shot, every asset at least once, looped to 8 seconds.
  const per = beat && beat.period ? (beat.period < 0.45 ? beat.period * 2 : beat.period) : TEMPLATES.beat.seconds;
  const beatScenes = [];
  let secs = 0;
  for (let i = 0; (secs < 8 || i < visuals.length) && beatScenes.length < 24; i++) {
    const a = visuals[i % visuals.length];
    const seconds = a.kind === 'video' ? Math.max(per, Math.min(1.6, a.seconds || per)) : per;
    beatScenes.push({ asset: a.id, seconds, text: i === 0 ? brandName : '' });
    secs += seconds;
  }
  titleOnce.clear();

  const spot = visuals.map((a) => ({
    asset: a.id,
    seconds: a.kind === 'video' ? Math.min(4.5, a.seconds || 2.5) : 2.5,
    text: textFor(a, TEMPLATES.spotlight.textMax),
  }));
  titleOnce.clear();
  const story = visuals.map((a, i) => ({
    asset: a.id,
    seconds: a.kind === 'video' ? Math.min(6, a.seconds || 3.5) : 3.5,
    text: i === 0 ? textFor(a, TEMPLATES.story.textMax) : '',
  }));

  return [
    { template: 'beat', aspect, title: 'Quick cuts', why: beat ? 'Cut on the beat at ' + beat.bpm + ' BPM.' : 'Fast cuts, ' + per + 's a shot.', scenes: beatScenes, audio, end },
    { template: 'spotlight', aspect, title: 'Product spotlight', why: 'One product at a time with its name.', scenes: spot, audio, end },
    { template: 'story', aspect, title: 'Slow story', why: 'Crossfades and a slow drift.', scenes: story, audio, end },
  ].map((p) => normalizePlan(p, assets)).filter(Boolean);
}

/**
 * Tempo of a song from its samples (mono Float32Array), for cutting on the beat. An onset
 * envelope (rises in short-window energy), autocorrelated over 70 to 180 BPM; the phase
 * that lines up with the most onsets says where the first beat falls. Reads at most the
 * first 45 seconds after `fromSec`. Returns { bpm, period, offset } in seconds, or null
 * when nothing rhythmic stands out.
 */
export function detectTempo(samples, sampleRate, fromSec = 0) {
  const hop = 512;
  const start = Math.floor(fromSec * sampleRate);
  const stop = Math.min(samples.length, start + 45 * sampleRate);
  const n = Math.floor((stop - start) / hop);
  if (n < 64) return null;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = start + i * hop, k = 0; k < hop; j++, k++) sum += samples[j] * samples[j];
    energy[i] = Math.sqrt(sum / hop);
  }
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, energy[i] - energy[i - 1]);

  const rate = sampleRate / hop;               // envelope frames per second
  const minLag = Math.floor((60 / 180) * rate);
  const maxLag = Math.ceil((60 / 70) * rate);
  let best = 0, bestLag = 0, sumAll = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    sumAll += s;
    if (s > best) { best = s; bestLag = lag; }
  }
  const mean = sumAll / (maxLag - minLag + 1);
  if (!bestLag || best < mean * 1.15) return null;

  let bestPhase = 0, phaseScore = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0;
    for (let i = p; i < n; i += bestLag) s += env[i];
    if (s > phaseScore) { phaseScore = s; bestPhase = p; }
  }
  const period = bestLag / rate;
  return { bpm: Math.round(60 / period), period: round(period), offset: round(fromSec + bestPhase / rate) };
}
