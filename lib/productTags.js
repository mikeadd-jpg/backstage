// The tags a built listing goes to Printify (and so Shopify) with. Storefront collections
// are smart collections on these tags, so a wrong tag puts a product in the wrong part of
// the site. Pure, no imports, so scripts/check-tags.mjs can run it without a database.
//
// The product_config row (edited in Settings) still supplies the descriptive tags, but on
// a store listed in KIDS_RULES the audience tags are decided here from the garment, not
// trusted from the row: on 2026-10-24 every Elder Emo kids row carried `elderemo`, the
// adults collection's rule tag, and the AU kids rows did not exist at all, so 74 kids
// listings landed under Elders and some missed the kids collections entirely.

// Per store, read off its smart collections on 2026-10-25. Only Elder Emo was checked;
// another store's kids tags pass through from its config rows until it is added here.
export const KIDS_RULES = {
  elderemo: {
    // `elder-emo-apparel` is tag = elderemo AND tag != upsellprod.
    adultOnly: ['elderemo'],
    // Age-group collection tag (Babies `infants`, Toddlers `toddler`, Kids `youthsizes`)
    // plus the descriptive tags the older hand-made products use. `kids-best-sellers` is
    // toddler OR onesie, which is why the long sleeve keeps `onesie`.
    audience: {
      onesie: ['infants', 'onesie'],
      ls_bodysuit: ['infants', 'long', 'onesie'],
      baby_tee: ['infants', 'babytee'],
      toddler_tee: ['toddler'],
      youth_tee: ['youthsizes'],
    },
    // The first kids config rows used these; the older convention above replaces them.
    retired: ['longsleeve bodysuit', 'baby tee'],
  },
};

// The blank tag per Printify blueprint. The sub-collections (baby-onesies, toddler-tees,
// youth-tees...) key off these, and a slot can be filled by more than one blueprint, so the
// tag follows the blueprint actually built rather than the config row.
export const BLANK_TAGS = {
  33: 'rabbitskins4424',
  31: 'rabbitskins4411',
  34: 'rabbitskins3322',
  32: 'rabbitskins3321',
  580: 'bellacanvas3001t',
  157: 'gildan5000b',
};

const UPSELL_TAG = 'upsellprod';
const UPSELL_EXEMPT = ['gildan_tee'];

// { brand, group: 'adults'|'kids', slotKey, blueprintId, configTags, marketTags } -> string[]
export function listingTags({ brand, group, slotKey, blueprintId, configTags = [], marketTags = [] }) {
  const tags = [];
  const add = (t) => { if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t); };
  const rules = KIDS_RULES[brand];

  if (group === 'kids' && rules) {
    const audience = rules.audience[slotKey];
    if (!audience) throw new Error('No audience tags for kids garment "' + slotKey + '". Add it to KIDS_RULES in lib/productTags.js.');
    const drop = new Set([...rules.adultOnly, ...rules.retired, ...Object.values(BLANK_TAGS)].map((t) => t.toLowerCase()));
    for (const t of configTags) if (!drop.has(t.toLowerCase())) add(t);
    add('kids');
    for (const t of audience) add(t);
    add(BLANK_TAGS[blueprintId]);
  } else {
    for (const t of configTags) add(t);
    if (group === 'adults' && !UPSELL_EXEMPT.includes(slotKey)) add(UPSELL_TAG);
  }
  for (const t of marketTags) add(t);

  // The guarantee, checked on the way out so no future edit above can quietly undo it.
  if (group === 'kids' && rules && tags.some((t) => rules.adultOnly.includes(t.toLowerCase()))) {
    throw new Error('Refusing to tag a kids listing as adult (' + tags.join(', ') + ').');
  }
  return tags;
}
