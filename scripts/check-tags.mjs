// Checks the builder's tag rules (lib/productTags.js) without touching Printify or the
// database: every kids garment, on every blueprint that can fill it, in every market,
// must come out with `kids`, its age-group tag and its blank tag, and never `elderemo`,
// even when its Settings row says otherwise. Run with `npm run check-tags`.
import assert from 'node:assert/strict';
import { listingTags, KIDS_RULES, BLANK_TAGS } from '../lib/productTags.js';
import { KIDS_CATALOG } from '../lib/kids.js';

const MARKET_TAGS = ['us', 'ca', 'uk', 'au'];
const AGE = { onesie: 'infants', ls_bodysuit: 'infants', baby_tee: 'infants', toddler_tee: 'toddler', youth_tee: 'youthsizes' };
// What the live Elder Emo rows held on 2026-10-25, plus no row at all (AU had none).
const CONFIGS = [
  (g) => ['elderemo', 'kids', g.key === 'ls_bodysuit' ? 'longsleeve bodysuit' : g.key === 'baby_tee' ? 'baby tee' : g.label.toLowerCase(), 'us', 'bellacanvas3001t'],
  () => ['ElderEmo', 'adult'],
  () => [],
];

let n = 0;
for (const g of KIDS_CATALOG) {
  assert.ok(KIDS_RULES.elderemo.audience[g.key], g.key + ' has no audience tags in KIDS_RULES');
  for (const bp of g.blueprints) {
    assert.ok(BLANK_TAGS[bp], 'blueprint ' + bp + ' (' + g.key + ') has no blank tag in BLANK_TAGS');
    for (const m of MARKET_TAGS) {
      for (const cfg of CONFIGS) {
        const tags = listingTags({ brand: 'elderemo', group: 'kids', slotKey: g.key, blueprintId: bp, configTags: cfg(g), marketTags: [m] });
        const lower = tags.map((t) => t.toLowerCase());
        assert.ok(!lower.includes('elderemo'), g.key + ' ' + m + ' got elderemo: ' + tags);
        assert.ok(!lower.includes('upsellprod'), g.key + ' ' + m + ' got upsellprod: ' + tags);
        for (const want of ['kids', AGE[g.key], BLANK_TAGS[bp], m]) assert.ok(lower.includes(want.toLowerCase()), g.key + ' ' + m + ' missing ' + want + ': ' + tags);
        const blanks = lower.filter((t) => Object.values(BLANK_TAGS).includes(t));
        assert.deepEqual(blanks, [BLANK_TAGS[bp]], g.key + ' ' + m + ' carries the wrong blank: ' + tags);
        n++;
      }
    }
  }
}

// Adults keep their row's tags, `elderemo` included, and get `upsellprod` except the Gildan.
const adult = listingTags({ brand: 'elderemo', group: 'adults', slotKey: 'comfort_colors_tee', blueprintId: 706, configTags: ['elderemo', 'adult', 'cc1717'], marketTags: ['us'] });
assert.ok(adult.includes('elderemo') && adult.includes('upsellprod'), 'adult tags: ' + adult);
const gildan = listingTags({ brand: 'elderemo', group: 'adults', slotKey: 'gildan_tee', blueprintId: 6, configTags: ['elderemo', 'adult'], marketTags: ['us', 'ca', 'uk', 'au'] });
assert.ok(gildan.includes('elderemo') && !gildan.includes('upsellprod'), 'gildan tags: ' + gildan);

// Hoodie: Global (Gildan 18500) is ca/uk/au with gildan18500, US (Lane Seven) is us with
// ls14001, neither gets upsellprod, and a stray blank tag in the row follows the blueprint.
const hoodieRow = ['elderemo', 'hoodie', 'gildan18500'];
const gf = listingTags({ brand: 'elderemo', group: 'adults', slotKey: 'hoodie', blueprintId: 77, configTags: hoodieRow, marketTags: ['ca', 'uk', 'au'] });
assert.deepEqual(gf, ['elderemo', 'hoodie', 'gildan18500', 'ca', 'uk', 'au'], 'hoodie global tags: ' + gf);
const l7 = listingTags({ brand: 'elderemo', group: 'adults', slotKey: 'hoodie', blueprintId: 439, configTags: hoodieRow, marketTags: ['us'] });
assert.deepEqual(l7, ['elderemo', 'hoodie', 'ls14001', 'us'], 'hoodie US tags: ' + l7);

console.log('ok: ' + n + ' kids listings checked, adults unchanged, hoodie tagged per blank');
