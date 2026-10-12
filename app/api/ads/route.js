// The Ads tab: carousel ad creatives built from images already in a brand's Meta ad
// account library (usually the mockups sent there from the Mockups tab).
//
//   GET                               which stores have an ad account, and what is missing
//   { action: 'library', brand }      the account's images, mapped to Shopify products
//   { action: 'recent', brand }       carousels built here for this brand
//   { action: 'build', brand, ... }   create one carousel creative
//
// A creative is an unpublished post. Nothing here creates an ad, an ad set or a campaign,
// or spends anything: the person picks an ad set and publishes in Ads Manager. See the
// header of lib/meta.js before widening that. Not exposed over MCP.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, shopPrimaryUrl } from '../../../lib/shopify.js';
import {
  metaAccountFor, metaPageFor, metaInstagramFor, listAdImages, createCarouselCreative,
  listBuiltCreatives, CTA_TYPES,
} from '../../../lib/meta.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MIN_CARDS = 2;
const MAX_CARDS = 10;   // Meta's own limit for a carousel

// Mockups pushed to Meta are named <brand>-<handle>-lifestyle.png (app/api/mockups), which
// is what lets a library image be traced back to its product.
const MOCKUP_SUFFIX = '-lifestyle.png';
function handleFromName(brand, name) {
  const n = String(name || '');
  if (!n.startsWith(brand + '-') || !n.endsWith(MOCKUP_SUFFIX)) return null;
  return n.slice(brand.length + 1, -MOCKUP_SUFFIX.length) || null;
}

// Built creatives are named with this prefix so the tab can find them again. One ad
// account serves two brands, so the brand is part of it.
const namePrefix = (brand) => 'Backstage · ' + BRANDS[brand].name + ' · ';

function checkBrand(brand) {
  if (!brand || !configuredShopifyBrands().includes(brand) || !metaAccountFor(brand)) {
    throw new Error('No ad account is configured for ' + brand + '.');
  }
  return brand;
}

const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ''));

export async function GET(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  const tokenSet = Boolean(process.env.META_ACCESS_TOKEN);
  const brands = configuredShopifyBrands().filter((b) => metaAccountFor(b)).map((b) => ({
    key: b,
    name: BRANDS[b].name,
    account: metaAccountFor(b),
    page: metaPageFor(b),
    instagram: metaInstagramFor(b),
  }));
  return NextResponse.json({
    brands, tokenSet, ctaTypes: CTA_TYPES, minCards: MIN_CARDS, maxCards: MAX_CARDS,
  });
}

export async function POST(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();

    if (body.action === 'library') {
      const brand = checkBrand(body.brand);
      // Products and the store address are for filling in cards; if Shopify fails the
      // library still loads and the cards are typed by hand.
      const [images, products, shopUrl] = await Promise.all([
        listAdImages(brand),
        listActiveProducts(brand).catch(() => []),
        shopPrimaryUrl(brand).catch(() => ''),
      ]);
      const byHandle = new Map(products.map((p) => [p.handle, p]));
      return NextResponse.json({
        shopUrl,
        products: products.map((p) => ({ handle: p.handle, title: p.title })),
        images: images.map((img) => {
          const handle = handleFromName(brand, img.name);
          const product = handle ? byHandle.get(handle) : null;
          return {
            ...img,
            mockup: Boolean(handle),
            handle,
            title: product ? product.title : null,
          };
        }),
      });
    }

    if (body.action === 'recent') {
      const brand = checkBrand(body.brand);
      return NextResponse.json({ creatives: await listBuiltCreatives(brand, namePrefix(brand)) });
    }

    if (body.action === 'build') {
      const brand = checkBrand(body.brand);
      const cards = Array.isArray(body.cards) ? body.cards : [];
      if (cards.length < MIN_CARDS || cards.length > MAX_CARDS) {
        throw new Error('A carousel needs ' + MIN_CARDS + ' to ' + MAX_CARDS + ' cards.');
      }
      const clean = cards.map((c, i) => {
        const hash = String(c.hash || '').trim();
        const headline = String(c.headline || '').trim();
        const link = String(c.link || '').trim();
        if (!hash) throw new Error('Card ' + (i + 1) + ' has no image.');
        if (!headline) throw new Error('Card ' + (i + 1) + ' needs a headline.');
        if (!isUrl(link)) throw new Error('Card ' + (i + 1) + ' needs a link starting with https://.');
        return { hash, headline, link, description: String(c.description || '').trim() };
      });
      const shopUrl = await shopPrimaryUrl(brand).catch(() => '');
      const label = String(body.name || '').trim() || new Date().toISOString().slice(0, 10);
      const result = await createCarouselCreative(brand, {
        name: namePrefix(brand) + label,
        message: String(body.message || '').trim(),
        link: isUrl(shopUrl) ? shopUrl : clean[0].link,
        cards: clean,
        cta: body.cta,
        reorder: body.reorder,
        endCard: body.endCard,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
