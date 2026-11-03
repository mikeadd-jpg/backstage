// Edit plans for the Ads tab's video builder: which asset is on screen for how long, what
// text goes over it, which song plays, a line of text that stays up through every shot, a
// logo overlay, the font, and the end card (the generated one, brand kit images, or both). A plan is plain data, so the same
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

export const END_SECONDS = 2.5;        // the generated end card
export const CARD_SECONDS = 2;         // each brand kit end card image
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

// Where the text block that stays through every shot sits, and the logo overlay. Both keep
// clear of the top and bottom bands where Reels draws its own buttons.
export const CAPTION_POSITIONS = { top: 'Top', center: 'Middle', bottom: 'Bottom' };
export const CAPTION_STYLES = { plain: 'White with a shadow', bar: 'On a brand colour bar' };
export const CAPTION_MAX = 90;
export const LOGO_POSITIONS = { 'top-left': 'Top left', 'top-center': 'Top middle', 'top-right': 'Top right', 'bottom-center': 'Bottom middle' };
export const LOGO_SIZES = { small: 0.16, medium: 0.24, large: 0.34 };   // share of the frame's width

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
  const endCardCount = Math.min(6, Array.isArray(raw.end && raw.end.cards) ? raw.end.cards.length : 0);
  if (total + endCardCount * CARD_SECONDS > MAX_SECONDS) {
    // Room for the end cards comes off the last shots rather than the cards.
    while (scenes.length > 1 && total + endCardCount * CARD_SECONDS > MAX_SECONDS) total -= scenes.pop().seconds;
  }

  let audio = null;
  const au = raw.audio && byId.get(String(raw.audio.asset));
  if (au && au.kind === 'audio') {
    const from = Math.max(0, Math.min(Number(raw.audio.from) || 0, Math.max(0, (au.seconds || 0) - 1)));
    audio = { asset: au.id, from: round(from) };
  }

  const end = raw.end || {};
  const cards = [...new Set((Array.isArray(end.cards) ? end.cards : []).map(String))]
    .filter((id) => (byId.get(id) || {}).kind === 'endcard').slice(0, 6);

  let caption = null;
  const c = raw.caption || {};
  const ctext = clip(c.text, CAPTION_MAX);
  if (ctext) {
    caption = { text: ctext, position: CAPTION_POSITIONS[c.position] ? c.position : 'top', style: CAPTION_STYLES[c.style] ? c.style : 'plain' };
  }

  let logo = null;
  const lg = raw.logo && byId.get(String(raw.logo.asset));
  if (lg && lg.kind === 'logo') {
    logo = {
      asset: lg.id,
      position: LOGO_POSITIONS[raw.logo.position] ? raw.logo.position : 'top-right',
      size: LOGO_SIZES[raw.logo.size] ? raw.logo.size : 'small',
    };
  }
  const font = raw.font && (byId.get(String(raw.font)) || {}).kind === 'font' ? String(raw.font) : null;

  return {
    template,
    aspect,
    title: clip(raw.title, 60) || t.label,
    why: clip(raw.why, 300),
    scenes,
    audio,
    caption,
    logo,
    font,
    end: {
      headline: clip(end.headline, 60),
      cta: clip(end.cta, 24) || 'Shop now',
      cards,
      // The generated card is on unless switched off, and always on when there is no image
      // card, so an ad never just stops.
      generated: end.generated === false && cards.length ? false : true,
    },
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
  const endStart = Math.max(0, at - overlap);
  const cardFrames = Math.round(CARD_SECONDS * FPS);
  const cards = (plan.end.cards || []).map((id, i) => ({ asset: id, start: endStart + i * cardFrames, frames: cardFrames }));
  const genStart = endStart + cards.length * cardFrames;
  const genFrames = plan.end.generated === false ? 0 : Math.round(END_SECONDS * FPS);
  return {
    scenes, overlap,
    endStart,                       // where the shots stop and the end begins
    cards,                          // brand kit end card images, in order
    genStart, genFrames,            // the generated end card, if on
    total: genStart + genFrames,
  };
}

export const planSeconds = (plan) => timeline(plan).total / FPS;

/**
 * The three fixed cuts from the assets in the order the person put them: no model call.
 * `beat` is detectTempo()'s answer for the first song, if there is one, so Quick cuts land
 * on the music. On-screen text is the product title where the asset has one; Claude's
 * plans are the way to get written copy.
 */
export function templatePlans(assets, { aspect = '9:16', beat = null, brandName = '', defaults = {} } = {}) {
  const visuals = (assets || []).filter(isVisual);
  if (!visuals.length) return [];
  // A song the person added wins; otherwise the brand's default approved track.
  const songs = (assets || []).filter((a) => a.kind === 'audio');
  const song = songs.find((a) => a.origin !== 'kit') || songs[0] || null;
  const titled = visuals.find((a) => a.title);
  const end = {
    headline: (visuals.length === 1 && titled ? titled.title : brandName) || brandName, cta: 'Shop now',
    cards: defaults.endcard ? [defaults.endcard] : [], generated: !defaults.endcard,
  };
  const songBeat = beat && song && song.id === beat.asset ? beat : song && song.beat ? song.beat : null;
  const audio = song ? { asset: song.id, from: songBeat ? songBeat.offset : 0 } : null;
  beat = songBeat;
  const extras = { font: defaults.font || null, logo: null, caption: null };
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
    { template: 'beat', aspect, title: 'Quick cuts', why: beat ? 'Cut on the beat at ' + beat.bpm + ' BPM.' : 'Fast cuts, ' + per + 's a shot.', scenes: beatScenes, audio, end, ...extras },
    { template: 'spotlight', aspect, title: 'Product spotlight', why: 'One product at a time with its name.', scenes: spot, audio, end, ...extras },
    { template: 'story', aspect, title: 'Slow story', why: 'Crossfades and a slow drift.', scenes: story, audio, end, ...extras },
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
