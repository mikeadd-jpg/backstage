// The Ads tab: carousel ad creatives built from images already in a brand's Meta ad
// account library (usually the mockups sent there from the Mockups tab).
//
//   GET                               which stores have an ad account, and what is missing
//   { action: 'library', brand }      the account's images, mapped to Shopify products
//   { action: 'recent', brand }       carousels built here for this brand
//   { action: 'build', brand, ... }   create one carousel creative
//   { action: 'write-text', brand, titles, notes, previous }  Claude drafts the primary text
//   { action: 'save-text-notes', brand, notes }               standing copy notes per store
//
//   { action: 'adsets', brand }       campaigns and ad sets to choose from (read-only)
//   { action: 'create-ad', brand, creativeId, adsetId, name }  a PAUSED ad in that ad set
//
// A creative is an unpublished post, and an ad is only ever created paused. Nothing here
// creates an ad set or a campaign, touches a budget, or switches anything on: that stays
// in Ads Manager. See the header of lib/meta.js before widening that. Not exposed over MCP.
import { NextResponse } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, shopPrimaryUrl } from '../../../lib/shopify.js';
import { writePrimaryText, adNotesFor, saveAdNotes } from '../../../lib/adcopy.js';
import {
  metaAccountFor, listAdImages, createCarouselCreative, listBuiltCreatives,
  resolveMetaPage, resolveInstagram, listAdSets, createPausedAd, CTA_TYPES,
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

// Page lookup needs to know whether another brand advertises from the same account,
// because then "the account's only Page" is not a safe guess.
function pageFor(brand) {
  const account = metaAccountFor(brand);
  const shared = configuredShopifyBrands().some((b) => b !== brand && metaAccountFor(b) === account);
  return resolveMetaPage(brand, { brandName: BRANDS[brand].name, shared });
}

const isUrl = (u) => /^https?:\/\/\S+$/i.test(String(u || ''));

export async function GET(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  const tokenSet = Boolean(process.env.META_ACCESS_TOKEN);
  const keys = configuredShopifyBrands().filter((b) => metaAccountFor(b));
  const pages = await Promise.all(keys.map((b) => (tokenSet
    ? pageFor(b).catch((err) => ({ page: null, candidates: [], error: String(err.message || err) }))
    : { page: null, candidates: [] })));
  const notes = await Promise.all(keys.map((b) => adNotesFor(b).catch(() => '')));
  const igs = await Promise.all(keys.map((b, i) => (tokenSet
    ? resolveInstagram(b, pages[i].page && pages[i].page.id).catch(() => null)
    : null)));
  const brands = keys.map((b, i) => ({
    key: b,
    name: BRANDS[b].name,
    account: metaAccountFor(b),
    page: pages[i].page,                 // { id, name, source } or null
    pageCandidates: pages[i].candidates,
    pageError: pages[i].error || null,
    instagram: igs[i],                   // { id, username, source } or null
    textNotes: notes[i],
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

    if (body.action === 'write-text') {
      const brand = checkBrand(body.brand);
      const text = await writePrimaryText({
        brand,
        brandName: BRANDS[brand].name,
        titles: Array.isArray(body.titles) ? body.titles.map(String) : [],
        notes: typeof body.notes === 'string' ? body.notes.slice(0, 1000) : '',
        // Read here, not trusted from the client, so the store's rules always apply.
        standing: await adNotesFor(brand),
        previous: Array.isArray(body.previous) ? body.previous.map(String) : [],
      });
      return NextResponse.json({ text });
    }

    if (body.action === 'save-text-notes') {
      const brand = checkBrand(body.brand);
      await saveAdNotes(brand, typeof body.notes === 'string' ? body.notes.slice(0, 2000) : '');
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'adsets') {
      const brand = checkBrand(body.brand);
      return NextResponse.json({ adsets: await listAdSets(brand) });
    }

    if (body.action === 'create-ad') {
      const brand = checkBrand(body.brand);
      const creativeId = String(body.creativeId || '').trim();
      const adsetId = String(body.adsetId || '').trim();
      if (!/^\d+$/.test(creativeId)) throw new Error('No carousel to add.');
      if (!/^\d+$/.test(adsetId)) throw new Error('Pick an ad set.');
      const name = String(body.name || '').trim() || namePrefix(brand) + 'carousel';
      return NextResponse.json(await createPausedAd(brand, { adsetId, creativeId, name }));
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
      const { page, candidates } = await pageFor(brand);
      if (!page) {
        throw new Error('Could not tell which Facebook Page ' + BRANDS[brand].name + ' ads post as' +
          (candidates.length ? ' (found: ' + candidates.map((p) => p.name + ' ' + p.id).join(', ') + ')' : '') +
          '. Set ' + brand.toUpperCase() + '_META_PAGE_ID in Vercel.');
      }
      const shopUrl = await shopPrimaryUrl(brand).catch(() => '');
      const label = String(body.name || '').trim() || new Date().toISOString().slice(0, 10);
      const creativeName = namePrefix(brand) + label;
      const instagram = await resolveInstagram(brand, page.id).catch(() => null);
      const result = await createCarouselCreative(brand, {
        pageId: page.id,
        instagramId: instagram && instagram.id,
        name: creativeName,
        message: String(body.message || '').trim(),
        link: isUrl(shopUrl) ? shopUrl : clean[0].link,
        cards: clean,
        cta: body.cta,
        reorder: body.reorder,
        endCard: body.endCard,
      });
      return NextResponse.json({ ...result, name: creativeName });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}
