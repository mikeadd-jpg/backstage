// A brand's visual style for the video builder: colours by role, which brand kit font does
// which job, the look rules (corners, shadows, gradients) and written guidelines Claude
// reads when planning a cut. Saved per brand in app_settings (`brand_style_<brand>`),
// edited under the brand's Video brand kit in Settings.
//
// Pure, no imports: the tab, the templates and the routes all use it.

export const COLOR_ROLES = {
  background: { label: 'Background', about: 'End card and quiet fills' },
  text: { label: 'Text', about: 'Words on dark grounds' },
  primary: { label: 'Main action', about: 'Buttons, text bars' },
  highlight: { label: 'Highlight', about: 'Stickers, one loud moment' },
  panel: { label: 'Panel', about: 'Borders and quiet panels' },
};
export const FONT_ROLES = {
  headline: { label: 'Headlines', about: 'End card headline, quick cut words' },
  body: { label: 'Body', about: 'Captions and longer lines' },
  bold: { label: 'Bold', about: 'Buttons and text bars' },
  sticker: { label: 'Stickers', about: 'Short tilted tags on quick cuts only. Leave empty to skip stickers.' },
};

export const styleKey = (brand) => 'brand_style_' + brand;

const HEX = /^#[0-9a-f]{6}$/i;
export const GUIDELINES_MAX = 4000;

// Whatever was saved, made safe: only known roles, real hex colours, numeric font ids.
export function cleanStyle(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const colors = {};
  for (const k of Object.keys(COLOR_ROLES)) if (HEX.test(String((r.colors || {})[k] || ''))) colors[k] = r.colors[k].toUpperCase();
  const fonts = {};
  for (const k of Object.keys(FONT_ROLES)) {
    const id = Number((r.fonts || {})[k]);
    if (Number.isInteger(id) && id > 0) fonts[k] = id;
  }
  const look = r.look || {};
  return {
    colors,
    fonts,
    look: {
      uppercaseHeadlines: Boolean(look.uppercaseHeadlines),
      // Buttons follow the headlines unless set apart (Wallspoke: sentence-case headlines,
      // capitals on buttons). Unset means "as the headlines", which is how older styles drew.
      uppercaseButtons: look.uppercaseButtons === undefined ? Boolean(look.uppercaseHeadlines) : Boolean(look.uppercaseButtons),
      squareCorners: Boolean(look.squareCorners),
      // Round-ended buttons, or softly rounded corners like the rest of the style.
      pillButtons: look.pillButtons !== false,
      offsetShadow: Boolean(look.offsetShadow),
      borders: Boolean(look.borders),
      gradients: look.gradients !== false,
    },
    guidelines: String(r.guidelines || '').slice(0, GUIDELINES_MAX),
  };
}

// WCAG contrast, to pick readable text on a coloured bar or button.
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
const onColor = (bg, options) => options.reduce((best, c) => (contrast(bg, c) > contrast(bg, best) ? c : best), options[0]);

/**
 * Everything the templates draw with, concrete. `fontFamilies` maps a kit font id to the
 * family the tab loaded it under. With no style saved, it falls back to the brand accent
 * and the templates' original look, so a brand without a style renders as before.
 */
export function resolveStyle(style, fontFamilies = {}, accent = '#6D28D9') {
  const s = cleanStyle(style);
  const c = {
    background: s.colors.background || '#0B0B10',
    text: s.colors.text || '#FFFFFF',
    primary: s.colors.primary || accent,
    highlight: s.colors.highlight || s.colors.primary || accent,
    panel: s.colors.panel || '#1F1F24',
  };
  const fam = (role) => (s.fonts[role] && fontFamilies['k' + s.fonts[role]] ? '"' + fontFamilies['k' + s.fonts[role]] + '", ' : '');
  const ink = [c.background, c.text, '#000000', '#FFFFFF'];
  return {
    colors: c,
    onPrimary: onColor(c.primary, ink),
    onHighlight: onColor(c.highlight, ink),
    fonts: { headline: fam('headline'), body: fam('body'), bold: fam('bold') || fam('body'), sticker: fam('sticker') },
    hasSticker: Boolean(fam('sticker')),
    look: s.look,
    radius: s.look.squareCorners ? 0 : 14,
    // A hard flyer-on-a-wall shadow, or the soft default.
    shadow: (color) => (s.look.offsetShadow ? '6px 6px 0 ' + (color || c.text) : '0 10px 30px rgba(0,0,0,0.35)'),
    border: s.look.borders ? '4px solid ' + c.background : 'none',
    guidelines: s.guidelines,
  };
}
