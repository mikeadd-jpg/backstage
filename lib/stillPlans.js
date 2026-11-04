// Plans for the Ads tab's image builder: static ad images, the still counterpart of
// lib/adPlans.js. A plan is plain data (template, shape, which pictures fill which slots,
// headline, line under it, button text and where each sits, logo, text style, look) from the fixed templates
// here or from Claude (lib/stillPlan.js), checked by normalizeStill, and drawn by one
// Remotion composition (app/StillTemplates.jsx) rendered as a single frame.
//
// Pure, no imports beyond lib/adPlans.js: the tab imports this.
import { ASPECTS, FILTERS, TEXT_STYLES, TEXT_BOXES, noDashes } from './adPlans.js';

// Modelled on proven retail layouts, drawn in each brand's style rather than copied:
// a headline and logo over a full-bleed photo; a framed poster on the brand colour with a
// checker border; a lifestyle photo with a big headline and an offer bar; 2x2 and 3x3
// grids; a clean product card; and a "new drop" layout over a repeated brand word.
export const STILL_TEMPLATES = {
  hero: { label: 'Headline over photo', about: 'One full-bleed photo, headline and logo at the top.', slots: 1, headline: 28, sub: 60 },
  poster: { label: 'Framed poster', about: 'Brand colour with a checker border, headline, logo, the photo in a frame.', slots: 1, headline: 28, sub: 60 },
  offer: { label: 'Big headline and offer', about: 'Full-bleed lifestyle photo, a huge two line headline and an offer bar under it.', slots: 1, headline: 22, sub: 40 },
  grid4: { label: 'Grid of 4', about: 'Four photos, 2 by 2. A collection at a glance.', slots: 4, headline: 40, sub: 0 },
  grid9: { label: 'Grid of 9', about: 'Nine photos, 3 by 3, for a big range.', slots: 9, headline: 40, sub: 0 },
  product: { label: 'Product card', about: 'One product on a plain ground with room around it, a small headline under.', slots: 1, headline: 40, sub: 60 },
  drop: { label: 'New drop', about: 'The brand name repeated as a pattern, logo and title on top, the product in the middle, a bar at the bottom.', slots: 1, headline: 22, sub: 60 },
  feature: { label: 'Benefits and price tags', about: 'A full-bleed scene with plain space at the top: a row of up to 4 short benefits with icons, one short headline line under it (no sub as a rule), optional price tags beside the product and the logo at the bottom.', slots: 1, headline: 26, sub: 60, anchor: 'top' },
};

// How the product is shown in a shot. A competitor ad's way is kept (it is part of the
// idea), and it reaches the scene writer and the image model, so a hanger shot is never
// turned into a person wearing it.
export const PRESENTATIONS = {
  model: { label: 'On a person', about: 'someone wearing or holding it' },
  hanger: { label: 'On a hanger', about: 'hung on a hanger or hook, no person' },
  flat: { label: 'Laid flat', about: 'a flat lay on a surface, seen from above, no person' },
  product: { label: 'On its own', about: 'the product alone on a plain or simple ground, no person' },
  room: { label: 'In a room', about: 'hanging or standing in a lived-in room, for wall art and home goods' },
};
export const presentationLine = (k) => (PRESENTATIONS[k] && k !== 'model'
  ? 'Show the product ' + PRESENTATIONS[k].about.replace(', no person', '') + '. No person, hands or body anywhere in the frame.'
  : PRESENTATIONS[k] ? 'Show the product worn or held by a person.' : '');

// The feature layout's extras. Icons are drawn in app/StillTemplates.jsx.
export const BENEFIT_ICONS = ['pen', 'truck', 'paper', 'gift', 'star', 'heart', 'leaf', 'check', 'globe', 'frame', 'shirt', 'clock'];
const cleanBenefits = (a) => (Array.isArray(a) ? a : []).map((b) => ({
  icon: BENEFIT_ICONS.includes(b && b.icon) ? b.icon : 'check', text: clip(b && b.text, 34),
})).filter((b) => b.text).slice(0, 4);
const cleanTags = (a) => (Array.isArray(a) ? a : []).map((t) => ({
  label: clip(t && t.label, 22), price: clip(t && t.price, 12), was: clip(t && t.was, 12),
})).filter((t) => t.price).slice(0, 2);
export const STILL_KEYS = Object.keys(STILL_TEMPLATES);

export const GRID_GAPS = { none: 'No gaps', thin: 'Thin lines', border: 'Thick border' };

// ---- text placement --------------------------------------------------------------------
// The headline, the line under it and the button are drawn over the layout, each where its
// settings say: on or off, position (x, y as % of the frame; x is the left edge, centre or
// right edge per `align`), width (% of the frame), size (x the layout's own size), colour
// and a box behind it. Every layout starts them where it always drew them; switching
// layout puts them back there (`text.for` records whose positions they are).
export const TEXT_ELEMENTS = ['headline', 'sub', 'cta', 'benefits', 'tags'];
export const TEXT_ALIGNS = { left: 'Left', center: 'Centre', right: 'Right' };
// Brand colours by role, or '' for the layout's choice. Hex values are taken as typed.
export const TEXT_COLORS = { '': 'Layout default', text: 'Brand text', background: 'Brand background', primary: 'Main action',
  highlight: 'Highlight', panel: 'Panel', white: 'White', black: 'Black' };
export const TEXT_BOXES_BG = { none: 'None', primary: 'Main action', highlight: 'Highlight', panel: 'Panel', dark: 'Dark', light: 'Light' };

const T = (x, y, more = {}) => ({ x, y, v: 'middle', align: 'center', w: 84, size: 1, color: '', bg: 'none', ...more });
// The logo is placed the same way (no `show`: picking a logo turns it on).
export const PLACED = [...TEXT_ELEMENTS, 'logo'];
// `v` is which edge of the element y names (top, middle, bottom), so a headline grows away
// from what is near it; `attach` keeps the line under the headline wherever the headline
// goes, until it is moved on its own.
export const TEXT_DEFAULTS = {
  hero: { headline: T(50, 7, { v: 'top', shadow: true }), sub: T(50, 25, { attach: true, shadow: true }), cta: T(50, 90), logo: T(5, 92, { align: 'left' }) },
  poster: { headline: T(50, 7.5, { v: 'top', w: 80 }), sub: T(50, 24, { attach: true, w: 80 }), cta: T(50, 90.5), logo: T(9, 90.5, { align: 'left' }) },
  offer: { headline: T(6, 79, { v: 'bottom', align: 'left', w: 90, upper: true, shadow: true }), sub: T(0, 85, { align: 'left', w: 80, bg: 'highlight' }),
    cta: T(6, 92.5, { align: 'left' }), logo: T(6, 7, { align: 'left' }) },
  grid4: { headline: T(50, 50, { w: 70, bg: 'primary' }), sub: T(50, 61, { attach: true, w: 70 }), cta: T(50, 92), logo: T(50, 36) },
  grid9: { headline: T(50, 50, { w: 70, bg: 'primary' }), sub: T(50, 61, { attach: true, w: 70 }), cta: T(50, 92), logo: T(50, 36) },
  product: { headline: T(50, 73, { v: 'top' }), sub: T(50, 84, { attach: true }), cta: T(50, 93.5), logo: T(50, 7) },
  feature: { headline: T(50, 13, { v: 'top', w: 92 }), sub: T(50, 22, { attach: true, w: 80 }), cta: T(50, 85), logo: T(50, 93),
    benefits: T(50, 3, { v: 'top', w: 94 }), tags: T(6, 50, { align: 'left', w: 34 }) },
  drop: { headline: T(50, 11, { v: 'top', w: 86 }), sub: T(6, 91.5, { align: 'left', w: 56, bg: 'panel' }), cta: T(94, 91.5, { align: 'right' }), logo: T(5, 5.5, { align: 'left' }) },
};
// Each layout's size for each element, in 1080ths of the frame width, before `size`
// (for the logo, its width).
export const TEXT_SIZES = {
  hero: { headline: 96, sub: 34, cta: 34, logo: 150 }, poster: { headline: 84, sub: 34, cta: 34, logo: 140 },
  offer: { headline: 150, sub: 44, cta: 36, logo: 170 }, grid4: { headline: 64, sub: 32, cta: 32, logo: 200 },
  grid9: { headline: 64, sub: 32, cta: 32, logo: 200 }, product: { headline: 64, sub: 32, cta: 30, logo: 150 },
  drop: { headline: 92, sub: 34, cta: 30, logo: 110 },
  feature: { headline: 70, sub: 30, cta: 32, logo: 280, benefits: 19, tags: 40 },
};

// Benefits and price tags belong to the feature layout; elsewhere they sit at the top and
// the left, off by default (nothing fills them).
for (const k of Object.keys(TEXT_DEFAULTS)) {
  TEXT_DEFAULTS[k].benefits = TEXT_DEFAULTS[k].benefits || T(50, 3.5, { v: 'top', w: 94 });
  TEXT_DEFAULTS[k].tags = TEXT_DEFAULTS[k].tags || T(6, 50, { align: 'left', w: 34 });
  TEXT_SIZES[k].benefits = TEXT_SIZES[k].benefits || 22;
  TEXT_SIZES[k].tags = TEXT_SIZES[k].tags || 40;
}

const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const colorOk = (c) => (c === '' || TEXT_COLORS[c] !== undefined || /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c) : '');

// Where the plain space for words is in the picture (the planner looks): the feature
// layout's headline, line under, tags and button move into a left or right column.
export const TEXT_PLACES = ['top', 'left', 'right'];
function placed(template, place) {
  const defs = TEXT_DEFAULTS[template];
  if (template !== 'feature' || !['left', 'right'].includes(place)) return defs;
  const L = place === 'left', x = L ? 6 : 94, align = L ? 'left' : 'right';
  return { ...defs,
    headline: T(x, 17, { v: 'top', align, w: 46 }), sub: T(x, 30, { attach: true, align, w: 44 }),
    tags: T(x, 58, { align, w: 34 }), cta: T(x, 86, { align }) };
}

/** A layout's starting spots for its words, given where the plain space is. */
export function textDefaults(template, place) { return placed(TEXT_DEFAULTS[template] ? template : 'hero', place); }

function normalizeText(raw, template, words, place) {
  const defs = placed(template, place);
  const given = raw && typeof raw === 'object' ? raw : {};
  const same = given.for === template;
  const out = { for: template };
  for (const el of PLACED) {
    const d = defs[el];
    const g = given[el] && typeof given[el] === 'object' ? given[el] : {};
    const pos = same ? g : {};          // another layout's positions do not carry over
    out[el] = {
      // Unset means "shown if there are words", which is how older plans drew.
      // Benefits and price tags belong to the feature layout: carried into another one they
      // would sit on its headline, so there they start off.
      show: el === 'logo' ? true : (el === 'benefits' || el === 'tags') && template !== 'feature' && !same ? false
        : typeof g.show === 'boolean' ? g.show : !!words[el],
      x: num(pos.x, 0, 100, d.x), y: num(pos.y, 0, 100, d.y), w: num(pos.w, 20, 100, d.w),
      align: TEXT_ALIGNS[pos.align] ? pos.align : d.align,
      size: num(g.size, 0.4, 2.5, d.size),
      color: g.color !== undefined ? colorOk(g.color) : d.color,
      bg: TEXT_BOXES_BG[pos.bg] ? pos.bg : d.bg,
      upper: typeof g.upper === 'boolean' ? g.upper : d.upper,
      v: ['top', 'middle', 'bottom'].includes(pos.v) ? pos.v : d.v,
      attach: d.attach ? (typeof pos.attach === 'boolean' ? pos.attach : true) : false,
      shadow: d.shadow || false,
    };
  }
  return out;
}

const clip = (s, n) => noDashes(s).slice(0, n).trim();

export function normalizeStill(raw, assets) {
  if (!raw || typeof raw !== 'object') return null;
  const byId = new Map((assets || []).map((a) => [a.id, a]));
  const template = STILL_TEMPLATES[raw.template] ? raw.template : 'hero';
  const t = STILL_TEMPLATES[template];
  const pics = (Array.isArray(raw.images) ? raw.images : []).map(String).filter((id) => (byId.get(id) || {}).kind === 'image');
  if (!pics.length) return null;
  // A grid with fewer photos than slots repeats them, so it always fills.
  const images = Array.from({ length: t.slots }, (_, i) => pics[i % pics.length]);
  const lg = raw.logo && byId.get(String(raw.logo));
  return {
    template,
    aspect: ASPECTS[raw.aspect] ? raw.aspect : '4:5',
    title: clip(raw.title, 60) || t.label,
    why: clip(raw.why, 300),
    images,
    headline: clip(raw.headline, t.headline),
    sub: t.sub ? clip(raw.sub, t.sub) : '',
    cta: clip(raw.cta, 24),
    logo: lg && lg.kind === 'logo' ? lg.id : null,
    textStyle: TEXT_STYLES[raw.textStyle] ? raw.textStyle : 'brand',
    textBox: TEXT_BOXES[raw.textBox] ? raw.textBox : 'white',
    filter: FILTERS[raw.filter] ? raw.filter : null,
    tone: ['light', 'dark'].includes(raw.tone) ? raw.tone : null,
    place: TEXT_PLACES.includes(raw.place) ? raw.place : 'top',
    gap: GRID_GAPS[raw.gap] ? raw.gap : 'thin',
    benefits: cleanBenefits(raw.benefits),
    tags: cleanTags(raw.tags),
    text: normalizeText(raw.text, template, { headline: clip(raw.headline, t.headline), sub: t.sub ? clip(raw.sub, t.sub) : '', cta: clip(raw.cta, 24),
      benefits: cleanBenefits(raw.benefits).length ? 'yes' : '', tags: cleanTags(raw.tags).length ? 'yes' : '' },
      TEXT_PLACES.includes(raw.place) ? raw.place : 'top'),
  };
}

/**
 * One option per template from the pictures in the order the person put them, with no
 * model call. Headlines are the product title or the brand name; Claude's plans are the
 * way to get written copy and offers (which these never invent).
 */
export function templateStills(assets, { aspect = '4:5', brandName = '' } = {}) {
  const pics = (assets || []).filter((a) => a.kind === 'image');
  if (!pics.length) return [];
  const ids = pics.map((a) => a.id);
  const titled = pics.find((a) => a.title);
  // Logos and headlines start off: the picture leads, and each is one click to turn on.
  // The headline is filled in so turning it on shows something.
  const base = { aspect, textStyle: 'brand', logo: null, text: { headline: { show: false }, sub: { show: false } } };
  const keys = STILL_KEYS.filter((k) => !k.startsWith('grid') || pics.length >= 2);
  return keys.map((k) => normalizeStill({
    ...base,
    template: k,
    title: STILL_TEMPLATES[k].label,
    images: k === 'grid4' || k === 'grid9' ? ids : [ids[0]],
    headline: k === 'grid4' || k === 'grid9' ? '' : (titled ? titled.title : brandName),
    sub: '',
    cta: k === 'drop' || k === 'offer' ? 'Shop now' : '',
  }, assets)).filter(Boolean);
}
