// GET  /api/inspiration          -> competitor ads from the Competitor Ads sheet, plus the
//                                   stores an idea can be adapted for. ?refresh=1 skips
//                                   the five minute cache after a hand edit to the sheet.
// POST /api/inspiration          -> { action: 'analyze', adId, brand, image? } Claude
//                                   breaks the ad down and writes our version's recipe and
//                                   a Mockups scene. Text only: nothing is saved or sent.
//
// The ad is looked up by id from the sheet rather than taken from the client, so what
// Claude reads is what the sheet holds. Area `inspiration` (owner, admin, creative). Not
// exposed over MCP.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { readCompetitorAds, analyzeAd, sheetUrl } from '../../../lib/inspiration.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // the client shrinks screenshots well under this

const brandsList = () => configuredShopifyBrands().map((b) => ({ key: b, name: BRANDS[b].name }));

export async function GET(req) {
  const gate = await requireArea(req, 'inspiration');
  if (gate.error) return gate.error;
  const refresh = new URL(req.url).searchParams.get('refresh') === '1';
  try {
    const data = await readCompetitorAds({ force: refresh });
    return NextResponse.json({ ...data, brands: brandsList(), sheetUrl: sheetUrl() }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    // In band, so the tab can still offer the sheet link and say what to fix.
    return NextResponse.json({ error: String(err.message || err), brands: brandsList(), sheetUrl: sheetUrl() }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'inspiration');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();
    if (body.action !== 'analyze') throw new Error('Unknown action.');

    const brand = body.brand;
    if (!brand || !configuredShopifyBrands().includes(brand)) throw new Error('Pick one of our stores first.');
    const { ads } = await readCompetitorAds();
    const ad = ads.find((a) => a.id === String(body.adId || ''));
    if (!ad) throw new Error('That ad is no longer in the sheet. Refresh and try again.');

    let image = null;
    if (body.image) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(body.image));
      if (!m || !IMAGE_TYPES.includes(m[1])) throw new Error('The screenshot must be a PNG, JPEG, WebP or GIF.');
      if (m[2].length > MAX_IMAGE_B64) throw new Error('That screenshot is too large. Try a smaller one.');
      image = { mediaType: m[1], data: m[2] };
    }

    const recipe = await analyzeAd({ ad, brand, brandName: BRANDS[brand].name, image });
    return NextResponse.json({ recipe });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
