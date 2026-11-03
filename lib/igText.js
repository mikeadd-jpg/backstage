// Instagram's story text styles, as the builder draws them (TEXT_STYLES in lib/adPlans.js
// names them). Fonts are ones phones and computers already have, since Instagram's own
// are not ours to ship: a bold system sans for Classic, a book serif for Serif, condensed
// capitals for Strong. Sizes are a share of the frame height; padding and radius are px at
// 1920 tall, scaled for other heights.
export const IG_STYLES = {
  'ig-classic': {
    font: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif',
    weight: 700, upper: false, tracking: 0, size: 0.03, pad: [14, 26], radius: 16,
  },
  'ig-serif': {
    font: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    weight: 400, upper: false, tracking: 0.5, size: 0.037, pad: [10, 26], radius: 0,
  },
  'ig-strong': {
    font: '"DIN Condensed", "DIN Alternate", "Avenir Next Condensed", Bahnschrift, "Arial Narrow", sans-serif',
    weight: 600, upper: true, tracking: 1, size: 0.034, pad: [18, 40], radius: 999,
  },
};
