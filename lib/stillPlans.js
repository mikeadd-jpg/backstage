// Plans for the Ads tab's image builder: static ad images, the still counterpart of
// lib/adPlans.js. A plan is plain data (template, shape, which pictures fill which slots,
// headline, line under it, button text, logo, text style, look) from the fixed templates
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
};
export const STILL_KEYS = Object.keys(STILL_TEMPLATES);

export const GRID_GAPS = { none: 'No gaps', thin: 'Thin lines', border: 'Thick border' };

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
    gap: GRID_GAPS[raw.gap] ? raw.gap : 'thin',
  };
}

/**
 * One option per template from the pictures in the order the person put them, with no
 * model call. Headlines are the product title or the brand name; Claude's plans are the
 * way to get written copy and offers (which these never invent).
 */
export function templateStills(assets, { aspect = '4:5', brandName = '', defaults = {} } = {}) {
  const pics = (assets || []).filter((a) => a.kind === 'image');
  if (!pics.length) return [];
  const ids = pics.map((a) => a.id);
  const titled = pics.find((a) => a.title);
  // A light logo over photos and dark grounds, a dark one on a light colour (the poster
  // sits on the main action colour). `defaults.logoLight`/`logoDark` come from the kit.
  const light = defaults.logoLight || defaults.logo || null;
  const dark = defaults.logoDark || defaults.logo || null;
  const logoFor = (k) => (k === 'poster' ? (defaults.primaryIsLight ? dark : light) : defaults.backgroundIsLight && (k === 'product' || k === 'drop') ? dark : light);
  const base = { aspect, textStyle: 'brand' };
  const keys = STILL_KEYS.filter((k) => !k.startsWith('grid') || pics.length >= 2);
  return keys.map((k) => normalizeStill({
    ...base,
    template: k,
    logo: logoFor(k),
    title: STILL_TEMPLATES[k].label,
    images: k === 'grid4' || k === 'grid9' ? ids : [ids[0]],
    headline: k === 'grid4' || k === 'grid9' ? '' : (titled ? titled.title : brandName),
    sub: '',
    cta: k === 'drop' || k === 'offer' ? 'Shop now' : '',
  }, assets)).filter(Boolean);
}
