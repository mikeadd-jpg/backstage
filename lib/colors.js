// Swatch colours for the product builder, keyed by Printify colour name.
//
// Printify's catalog gives colour NAMES only; hex values exist only on products already
// created in a shop. These were collected from the live shops' products on 2026-10-14 and
// cover every colour the builder's blueprints offered that day, plus the AS Colour and
// Gildan GD12 names added with the UK and AU tank and crop blanks (Navy hand-corrected: the
// first product found carried a grey). They are a display aid,
// nothing is built from them. A colour missing here shows as a striped "unknown" swatch,
// so add a line when a new colour appears. Pure module: safe in the client bundle.
export const COLOR_HEX = {
  'Antique Cherry Red': '#A82235',
  'Antique Irish Green': '#018E54',
  'Antique Jade Dome': '#0D8581',
  'Antique Orange': '#D96538',
  'Antique Sapphire': '#0082AE',
  'Apple': '#5EC14F',
  'Army': '#6F7543',
  'Ash': '#F6F6F6',
  'Asphalt': '#525455',
  'Athletic Heather': '#C7C7C5',
  'Autumn': '#AF4D38',
  'Azalea': '#EF8FBC',
  'Banana': '#FFECB9',
  'Bay': '#C3CFC1',
  'Berry': '#875570',
  'Black': '#000000',
  'Blackberry': '#221C35',
  'Blossom': '#F8D1E2',
  'Blue Dusk': '#253746',
  'Blue Jean': '#636D82',
  'Blue Spruce': '#536758',
  'Bone': '#DED8CC',
  'Brick': '#914A4A',
  'Bright Orange': '#FFAD4F',
  'Bright Salmon': '#FF6B50',
  'Brown Savana': '#948272',
  'Bubblegum': '#FBB4C6',
  'Burnt Orange': '#E27C4B',
  'Butter': '#F5E1A4',
  'Camel': '#C18B49',
  'Cardinal Red': '#9F1931',
  'Carolina Blue': '#7BA4DB',
  'Chalky Mint': '#A7DCD4',
  'Chambray': '#E2F7FF',
  'Charcoal': '#585559',
  'Chili': '#853F44',
  'China Blue': '#43516E',
  'Citrus': '#FFC86E',
  'Coal': '#414245',
  'Cobalt': '#2A2E7B',
  'Coral Silk': '#E67376',
  'Cornsilk': '#F7EF8F',
  'Crimson': '#B65858',
  'Crunchberry': '#EB7CA2',
  'Daisy': '#FED141',
  'Dark Chocolate': '#31221D',
  'Dark Heather': '#454545',
  'Dark Heather Grey': '#383533',
  'Denim': '#4E5064',
  'Ecru': '#E7DED0',
  'Electric Green': '#4FB039',
  'Espresso': '#846B5B',
  'Flo Blue': '#7682C2',
  'Forest Green': '#223B26',
  'Garnet': '#6D222D',
  'Gold': '#FFB81C',
  'Granite': '#8A8E90',
  'Granite Heather': '#717679',
  'Grape': '#645C81',
  'Graphite': '#373231',
  'Graphite Heather': '#797C7E',
  'Gravel': '#9CA1A3',
  'Grey': '#909090',
  'Hazy Pink': '#A67C73',
  'Heather': '#B4B3B2',
  'Heather Columbia Blue': '#7791DB',
  'Heather Dust': '#F0E8E1',
  'Heather Maroon': '#5C3535',
  'Heather Mauve': '#D18786',
  'Heather Military Green': '#828067',
  'Heather Navy': '#424753',
  'Heather Purple': '#B49AA7',
  'Heather Radiant Orchid': '#D58EBB',
  'Heather Red': '#E3525F',
  'Heather Sapphire': '#59A1CE',
  'Heather Stone': '#B0AC98',
  'Heather Yellow Gold': '#FFC74C',
  'Heliconia': '#E37699',
  'Hemp': '#676A4A',
  'Hot Pink': '#F64D96',
  'Hydrangea': '#B2DAF3',
  'Ice Blue': '#7B8E95',
  'Ice Grey': '#D7D6D3',
  'Indigo Blue': '#476579',
  'Irish Green': '#279436',
  'Island Green': '#54B188',
  'Island Reef': '#A2D8C2',
  'Ivory': '#FFF7E7',
  'Jade': '#1D2E31',
  'Jade Dome': '#19998A',
  'Kelly': '#026539',
  'Khaki': '#AEA583',
  'Kiwi': '#C9DB77',
  'Lagoon': '#3BA5B5',
  'Lagoon Blue': '#89E4ED',
  'Lavender': '#AE89B7',
  'Light Blue': '#D6E6F7',
  'Light Green': '#69826A',
  'Light Pink': '#FEE0EB',
  'Lilac': '#563D82',
  'Lime': '#9EC46C',
  'Maroon': '#642838',
  'Mauvelous': '#EB989C',
  'Melon': '#FF9A5F',
  'Midnight': '#414A5B',
  'Military Green': '#62664C',
  'Mint Green': '#B1E0C0',
  'Moss': '#747F66',
  'Mustard': '#D0AE6E',
  'Mystic Blue': '#647CA3',
  'Natural': '#FFF6E3',
  'Natural Heather': '#E9E2D8',
  'Navy': '#1F2A44',
  'Neon Blue': '#004EA8',
  'Neon Green': '#A7E163',
  'Neon Lemon': '#C9DB78',
  'Neon Pink': '#F57CAF',
  'Neon Red Orange': '#FF867B',
  'Neon Violet': '#E8ACE3',
  'Old Gold': '#C99B5C',
  'Orange': '#EA5F22',
  'Orchid': '#CBB3CC',
  'Pale Pink': '#E1B29C',
  'Paprika': '#FF4645',
  'Peachy': '#F7C3AE',
  'Pepper': '#5F605B',
  'Periwinkle': '#6570AF',
  'Petrol Blue': '#3A444F',
  'Pink': '#FFCDCE',
  'Purple': '#3C214E',
  'Red': '#A80D27',
  'Royal': '#084F97',
  'Royal Caribe': '#5D8AC7',
  'Safety Green': '#F2FB00',
  'Safety Orange': '#F88D20',
  'Safety Pink': '#FF8E9D',
  'Sage': '#6D775C',
  'Sand': '#DCD2BE',
  'Sandstone': '#A69F88',
  'Sapphire': '#03B2D3',
  'Seafoam': '#609A95',
  'Silver': '#D6D5D1',
  'Sky': '#8BCDEA',
  'Sport Grey': '#CACACA',
  'Sunset': '#ED8957',
  'Tennessee Orange': '#F79B2E',
  'Terracotta': '#DB8C76',
  'Texas Orange': '#C26928',
  'Topaz Blue': '#1F6171',
  'Tropical Blue': '#0097A9',
  'True Navy': '#1C1B32',
  'True Royal': '#2B4DA4',
  'Turf Green': '#297937',
  'Tweed': '#4B4F54',
  'Vintage Indigo': '#5A8494',
  'Violet': '#A88FD7',
  'Washed Denim': '#8595B8',
  'Watermelon': '#DA665F',
  'White': '#FFFFFF',
  'Wine': '#5E5266',
  'Yam': '#C9814F',
  'Yellow': '#FFFB81',
  'Yellow Haze': '#FADFA6',
};

export function colorHex(name) {
  if (COLOR_HEX[name]) return COLOR_HEX[name];
  const lower = String(name || '').toLowerCase();
  const hit = Object.keys(COLOR_HEX).find((k) => k.toLowerCase() === lower);
  return hit ? COLOR_HEX[hit] : null;
}

// Colour families for per-colour designs. Every blank names its shades differently (the
// same dark grey is Charcoal, Pepper, Coal, Dark Heather or Graphite Heather), and one row
// per name made a build of seven garments ask for ~15 uploads, where a missed row quietly
// took the main design. So the builder asks once per family, and a family can still be
// split into its shades. Lower-case names; a colour in none of these gets its own row.
export const DESIGN_FAMILIES = [
  { key: 'black', label: 'Black', names: ['black'] },
  { key: 'navy', label: 'Navy', names: ['navy', 'true navy', 'heather navy', 'dark navy', 'navy heather',
    'heather sport dark navy', 'navy blazer', 'midnight navy'] },
  { key: 'dark grey', label: 'Dark grey', names: ['charcoal', 'pepper', 'coal', 'dark heather', 'graphite heather',
    'graphite', 'asphalt', 'charcoal heather', 'heather charcoal', 'dark grey heather', 'dark heather grey',
    'dark grey', 'smoke', 'vintage smoke'] },
  { key: 'light grey', label: 'Light grey', names: ['sport grey', 'heather grey', 'athletic heather', 'ash',
    'grey marle', 'ice grey', 'light grey', 'heather', 'grey'] },
  { key: 'off-white', label: 'Cream / off-white', names: ['natural', 'ivory', 'sand', 'cream', 'bone', 'ecru',
    'oatmeal', 'oatmeal heather', 'sandshell', 'heather dust', 'natural heather', 'vintage white', 'stone'] },
  { key: 'white', label: 'White', names: ['white'] },
];
export function designFamily(name) {
  const lower = String(name || '').toLowerCase();
  return DESIGN_FAMILIES.find((f) => f.names.includes(lower)) || null;
}

// Printify shipping uses ISO codes plus one catch-all bucket.
const COUNTRY_NAMES = {
  US: 'United States', CA: 'Canada', GB: 'United Kingdom', UK: 'United Kingdom',
  AU: 'Australia', NZ: 'New Zealand', REST_OF_THE_WORLD: 'Rest of world',
};
export function countryName(code) {
  return COUNTRY_NAMES[code] || code;
}

// Catalog variants -> one entry per colour, in catalog order, with its sizes.
export function groupByColor(variants) {
  const byName = new Map();
  for (const v of variants) {
    const name = v.options && v.options.color;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { name, hex: colorHex(name), sizes: [] });
    const size = v.options.size;
    if (size && !byName.get(name).sizes.includes(size)) byName.get(name).sizes.push(size);
  }
  const rank = (sz) => { const i = SIZE_ORDER.indexOf(sz); return i === -1 ? SIZE_ORDER.length : i; };
  for (const c of byName.values()) c.sizes.sort((x, y) => rank(x) - rank(y));
  return [...byName.values()];
}

// Printify returns sizes in no particular order. Unknown sizes sort last, stable.
const SIZE_ORDER = ['NB', '0-3M', '3-6M', '6M', '6-12M', '12M', '12-18M', '18M', '18-24M', '24M',
  '2T', '3T', '4T', '5T', '5/6T', 'XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
