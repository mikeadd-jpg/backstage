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

// Each template's min/max is its suggested shot length (shown to Claude and in the editor);
// any shot can be anywhere from SHOT_MIN to SHOT_MAX, so "every product 1 second" works
// whatever the template.
export const SHOT_MIN = 0.3;
export const SHOT_MAX = 8;
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
// How one shot gives way to the next. `frames` is how long the two overlap; a cut and a
// flash do not overlap. Each template has its own default, and a plan or a single shot
// can choose another.
export const TRANSITIONS = {
  cut: { label: 'Cut', frames: 0 },
  flash: { label: 'Flash', frames: 0 },
  crossfade: { label: 'Crossfade', frames: 15 },
  dip: { label: 'Dip to black', frames: 14 },
  slideLeft: { label: 'Slide left', frames: 10 },
  slideUp: { label: 'Slide up', frames: 10 },
  zoom: { label: 'Zoom in', frames: 10 },
  whip: { label: 'Whip pan', frames: 8 },
};
export const TEMPLATE_TRANSITION = { beat: 'flash', spotlight: 'cut', story: 'crossfade' };
export const transitionOf = (plan, scene) =>
  (scene && TRANSITIONS[scene.transition] ? scene.transition : null) ||
  (TRANSITIONS[plan.transition] ? plan.transition : null) || TEMPLATE_TRANSITION[plan.template] || 'cut';

// How the picture moves while it is on screen. Each template has its own default (quick
// cuts punch in, the spotlight pushes in, the story drifts); "still" keeps the picture
// exactly where it lands, for a product that flashes in and just stays.
export const MOTIONS = {
  still: 'None, the picture stays put',
  push: 'Slow push in',
  pull: 'Slow pull out',
  drift: 'Drift sideways',
  punch: 'Punch in on arrival',
};
export const TEMPLATE_MOTION = { beat: 'punch', spotlight: 'push', story: 'drift' };
export const motionOf = (plan) => (MOTIONS[plan.motion] ? plan.motion : TEMPLATE_MOTION[plan.template] || 'still');

// How on-screen words look: the brand style, or Instagram's own story text (bold sans on a
// rounded label, a serif on a square one, condensed capitals on a pill), in a white box,
// a black box or none.
export const TEXT_STYLES = {
  brand: 'Brand style',
  'ig-classic': 'Instagram classic',
  'ig-serif': 'Instagram serif',
  'ig-strong': 'Instagram strong',
};
export const TEXT_BOXES = { white: 'White box', black: 'Black box', none: 'No box' };

// Real colours, not the app's CSS vars: the renderer paints onto a canvas.
export const ACCENTS = { elderemo: '#6D28D9', poppunks: '#C6207A', wallspoke: '#1D5FD6', transworld: '#067A57' };

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

// About how long a Quick cuts template runs before its end card.
const QUICK_CUT_SECONDS = 8;
const fit = (n) => round(Math.min(SHOT_MAX, Math.max(SHOT_MIN, n)));
const sumSeconds = (scenes) => scenes.reduce((t, s) => t + (Number(s.seconds) || 0), 0);

/** Every shot the same length, together `total` seconds (each kept within SHOT_MIN..SHOT_MAX). */
export function spreadScenes(scenes, total) {
  if (!scenes.length || !(total > 0)) return scenes;
  const each = fit(total / scenes.length);
  return scenes.map((s) => ({ ...s, seconds: each }));
}

/** Shot i taken out, its time shared among the others in proportion, so the ad keeps its length. */
export function dropScene(scenes, i) {
  if (scenes.length < 2) return scenes;
  const total = sumSeconds(scenes);
  const rest = scenes.filter((_, k) => k !== i);
  const left = sumSeconds(rest) || 1;
  return rest.map((s) => ({ ...s, seconds: fit((s.seconds * total) / left) }));
}

/** Each asset kept at its first shot only, the time of the repeats shared among the rest. */
export function dropRepeats(scenes) {
  const seen = new Set();
  const total = sumSeconds(scenes);
  const rest = scenes.filter((s) => (seen.has(s.asset) ? false : (seen.add(s.asset), true)));
  if (rest.length === scenes.length) return scenes;
  const left = sumSeconds(rest) || 1;
  return rest.map((s) => ({ ...s, seconds: fit((s.seconds * total) / left) }));
}
export const hasRepeats = (scenes) => new Set(scenes.map((s) => s.asset)).size < scenes.length;

const isVisual = (a) => a && (a.kind === 'image' || a.kind === 'video');

// Where the text block that stays through every shot sits, and the logo overlay. Both keep
// clear of the top and bottom bands where Reels draws its own buttons.
export const CAPTION_POSITIONS = { top: 'Top', center: 'Middle', bottom: 'Bottom' };
export const CAPTION_STYLES = { plain: 'White with a shadow', bar: 'On a brand colour bar' };
export const CAPTION_MAX = 90;
export const LOGO_POSITIONS = { 'top-left': 'Top left', 'top-center': 'Top middle', 'top-right': 'Top right', 'bottom-center': 'Bottom middle' };
export const LOGO_SIZES = { small: 0.16, medium: 0.24, large: 0.34 };   // share of the frame's width

// A look over the pictures only (never text, the logo or end cards): a CSS filter, plus
// for some an `fx` layer the templates draw on top of each shot. grain: moving static at
// that opacity; scanlines, vignette: their opacity; flicker: how far brightness wobbles per
// frame; jitter: px the picture shakes, gliding to a new spot every `jitterEvery` frames
// (a slow wobble, not a buzz); tracking: a VHS band rolling down; scratches: old film
// lines; dust: specks. CSS filters render in Chrome and Edge; Safari renders unfiltered.
export const FILTERS = {
  vhs: { label: 'VHS', css: 'saturate(1.35) contrast(1.12) brightness(1.02) hue-rotate(-6deg)', fx: { grain: 0.22, scanlines: 0.3, vignette: 0.35, jitter: 3, jitterEvery: 12, tracking: true, flicker: 0.02 } },
  oldfilm: { label: 'Old movie', css: 'sepia(0.6) saturate(0.6) contrast(1.18) brightness(0.95)', fx: { grain: 0.32, vignette: 0.65, flicker: 0.08, jitter: 1.5, jitterEvery: 4, scratches: true, dust: true } },
  grainy: { label: 'Grainy', css: 'contrast(1.06)', fx: { grain: 0.26 } },
  static: { label: 'TV static', css: 'saturate(0.85) contrast(1.1)', fx: { grain: 0.5, scanlines: 0.18, flicker: 0.04 } },
  dusty: { label: 'Dust and scratches', css: '', fx: { grain: 0.1, scratches: true, dust: true } },
  faded: { label: 'Faded film', css: 'contrast(0.86) saturate(0.68) brightness(1.07) sepia(0.2)', fx: { grain: 0.14, vignette: 0.25 } },
  mono: { label: 'Black and white', css: 'grayscale(1) contrast(1.15)' },
  grunge: { label: 'Gritty', css: 'grayscale(0.45) contrast(1.35) brightness(0.9)', fx: { grain: 0.18 } },
  punchy: { label: 'Punchy', css: 'contrast(1.2) saturate(1.35)' },
  warm: { label: 'Warm', css: 'sepia(0.25) saturate(1.15) hue-rotate(-8deg)' },
  cool: { label: 'Cool', css: 'saturate(0.9) hue-rotate(14deg) brightness(1.03)' },
  night: { label: 'Night', css: 'brightness(0.78) contrast(1.2) saturate(0.8) hue-rotate(-12deg)' },
};

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
    const from = a.kind === 'video' ? Math.max(0, Math.min(Number(s.from) || 0, Math.max(0, (a.seconds || 0) - SHOT_MIN))) : 0;
    let seconds = Number(s.seconds) || t.seconds;
    seconds = Math.min(SHOT_MAX, Math.max(SHOT_MIN, seconds));
    if (a.kind === 'video' && a.seconds) seconds = Math.min(seconds, Math.max(0.3, a.seconds - from));
    if (total + seconds > MAX_SECONDS || scenes.length >= MAX_SCENES) break;
    total += seconds;
    scenes.push({
      asset: a.id, seconds: round(seconds), from: round(from), text: clip(s.text, t.textMax),
      ...(TRANSITIONS[s.transition] ? { transition: s.transition } : {}),
    });
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
  const filter = FILTERS[raw.filter] ? raw.filter : null;
  const motion = MOTIONS[raw.motion] ? raw.motion : null;
  const transition = TRANSITIONS[raw.transition] ? raw.transition : null;
  const textStyle = TEXT_STYLES[raw.textStyle] ? raw.textStyle : 'brand';
  const textBox = TEXT_BOXES[raw.textBox] ? raw.textBox : 'white';

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
    filter,
    motion,
    transition,
    textStyle,
    textBox,
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

// Frame timing for a plan. Each shot starts early by its transition's overlap (never more
// than half of either shot), so it plays over the end of the one before; `enter` says how.
// The end card fades in over the last shot when the plan's transition is a soft one.
const SOFT = ['crossfade', 'dip', 'zoom'];
export function timeline(plan) {
  let at = 0, prevLen = 0;
  const scenes = plan.scenes.map((s, i) => {
    const len = Math.max(1, Math.round(s.seconds * FPS));
    const type = i ? transitionOf(plan, s) : 'cut';
    const ov = i ? Math.min(TRANSITIONS[type].frames, Math.floor(prevLen / 2), Math.floor(len / 2)) : 0;
    const start = Math.max(0, at - ov);
    at = start + len; prevLen = len;
    return { ...s, start, frames: len, index: i, enter: { type, frames: ov } };
  });
  const planType = transitionOf(plan, null);
  const endOverlap = SOFT.includes(planType) ? Math.min(12, Math.floor(prevLen / 2)) : 0;
  const overlap = Math.max(endOverlap, 6);      // the end card's fade in
  const endStart = Math.max(0, at - endOverlap);
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
  // Fonts come from the brand style's roles; `font` is only a per-ad headline override.
  const extras = { font: null, logo: null, caption: null, filter: defaults.filter || null };
  const titleOnce = new Set();
  const textFor = (a, n) => {
    if (!a.title || titleOnce.has(a.id)) return '';
    titleOnce.add(a.id);
    return a.title.slice(0, n);
  };

  // Quick cuts: every asset once, never looped. With few assets each shot is held longer
  // so the cut still runs about 8 seconds (four pictures get two seconds each), in whole
  // beats when the song's tempo is known. Repeating pictures to fill the time was the old
  // way, and the owner asked for it to stop.
  const per = beat && beat.period ? (beat.period < 0.45 ? beat.period * 2 : beat.period) : TEMPLATES.beat.seconds;
  const want = Math.min(SHOT_MAX, Math.max(per, QUICK_CUT_SECONDS / visuals.length));
  const held = beat && beat.period ? Math.max(1, Math.round(want / per)) * per : want;
  const beatScenes = visuals.slice(0, MAX_SCENES).map((a, i) => ({
    asset: a.id,
    seconds: round(a.kind === 'video' ? Math.max(per, Math.min(held, a.seconds || held)) : held),
    text: i === 0 ? brandName : '',
  }));
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
