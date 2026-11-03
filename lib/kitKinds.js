// What a brand kit holds, shared by Settings (uploads), the brand-kit routes (checks) and
// the video builder. Pure, no imports, so the tab can use it.
//
// Sizes are generous on purpose: uploads go from the browser straight to Vercel Blob,
// never through a function, so Vercel's 4.5MB request limit does not apply.

export const KIT_KINDS = {
  endcard: {
    label: 'End card images',
    about: 'Shown full frame at the end of a video ad, in the order you pick. Make them the ad\'s shape (1080x1920 for Reels).',
    accept: 'image/png,image/jpeg,image/webp',
    types: ['image/png', 'image/jpeg', 'image/webp'],
    max: 20 * 1024 * 1024,
  },
  logo: {
    label: 'Logos',
    about: 'Transparent PNG or SVG, laid over the video when you switch the logo overlay on.',
    accept: 'image/png,image/svg+xml,image/webp',
    types: ['image/png', 'image/svg+xml', 'image/webp'],
    max: 10 * 1024 * 1024,
  },
  font: {
    label: 'Fonts',
    about: 'TTF, OTF, WOFF or WOFF2. Used for every word on screen. Make sure the license covers ads.',
    accept: '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2',
    types: ['font/ttf', 'font/otf', 'font/woff', 'font/woff2'],
    max: 10 * 1024 * 1024,
  },
  music: {
    label: 'Approved music',
    about: 'Tracks cleared for this brand\'s ads. The first is used by default; the tempo is measured on upload for cutting on the beat.',
    accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/aac',
    types: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac'],
    max: 60 * 1024 * 1024,
  },
};
export const KIT_KEYS = Object.keys(KIT_KINDS);

// Browsers often leave File.type empty for fonts, so the type is taken from the extension.
const FONT_TYPES = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
export function kitContentType(kind, file) {
  if (kind === 'font') return FONT_TYPES[String(file.name).split('.').pop().toLowerCase()] || '';
  return file.type || '';
}

// Where a kind's files live in the store. The routes only accept uploads under it.
export const kitPrefix = (brand, kind) => 'brand-kit/' + brand + '/' + kind + '/';
