// The Ads tab: carousel ad creatives built from images already in a brand's Meta ad
// account library (usually the mockups sent there from the Mockups tab), and video ads
// from a reel made in Canva.
//
//   GET                               which stores have an ad account, and what is missing
//   { action: 'library', brand }      the account's images, mapped to Shopify products
//   { action: 'recent', brand }       carousels built here for this brand
//   { action: 'build', brand, ... }   create one carousel creative
//   { action: 'write-text', brand, titles, notes, previous }  Claude drafts the primary text
//   { action: 'save-text-notes', brand, notes }               standing copy notes per store
//
//   Video from Canva, one step per request so none waits on a long export or upload:
//   { action: 'canva-designs', query, continuation }  the connected account's designs
//   { action: 'video-export', designId, vertical }    start an MP4 export in Canva
//   { action: 'video-export-status', exportId }       poll it; returns the download url
//   { action: 'video-to-meta', brand, url, title }    Meta fetches the MP4 into the account
//   { action: 'video-status', brand, videoId }        poll Meta's processing
//   { action: 'build-video', brand, videoId, ... }    create the video ad creative
//
//   Video builder (app/AdStudio.jsx): the video is made on the device, then sent through
//   /api/ads/video-upload and finished with 'video-status' and 'build-video' above.
//   { action: 'plan-video', brand, assets, aspect, notes, beat, previous }  Claude plans 3 cuts
//
//   Image builder (app/StillStudio.jsx): the image is made on the device.
//   { action: 'plan-still', brand, assets, aspect, notes, previous }   Claude plans 3 images
//   { action: 'image-to-meta', brand, b64, title }  into the ad image library, returns the hash
//   { action: 'build-image', brand, hash, ... }     a single image ad creative
//
//   { action: 'check-access', brand } what the Meta token can do for this brand (read-only)
//   { action: 'collections', brand }  the store's collections, for "you might also like"
//   { action: 'landing-page', brand, title, handles, alsoLike }  a manual Shopify collection
//                                     of the ad's products, in order, published to the Online
//                                     Store, optionally with a "you might also like" collection
//
//   { action: 'adsets', brand }       campaigns and ad sets to choose from (read-only)
//   { action: 'create-ad', brand, creativeId, adsetId, name }  a PAUSED ad in that ad set
//
// A creative is an unpublished post, and an ad is only ever created paused. Nothing here
// creates an ad set or a campaign, touches a budget, or switches anything on: that stays
// in Ads Manager. See the header of lib/meta.js before widening that. Not exposed over MCP.
import { NextResponse, after } from 'next/server';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import { listActiveProducts, shopPrimaryUrl, createLandingCollection, listCollections, bestSellers } from '../../../lib/shopify.js';
import { printifyMockupIndex, mockupsFor } from '../../../lib/printifyMockups.js';
import { listDrafts } from '../../../lib/drafts.js';
import { writePrimaryText, adNotesFor, saveAdNotes } from '../../../lib/adcopy.js';
import {
  metaAccountFor, listAdImages, createCarouselCreative, listBuiltCreatives,
  resolveMetaPage, resolveInstagram, listAdSets, createPausedAd, CTA_TYPES,
  uploadAdVideoFromUrl, adVideoStatus, createVideoCreative, checkMetaAccess,
  uploadAdImage, createImageCreative, creativeNamePrefix, pageForBrand, adIdentity,
} from '../../../lib/meta.js';
import { planVideos } from '../../../lib/adVideo.js';
import { planStills } from '../../../lib/stillPlan.js';
import { recordMeta } from '../../../lib/adResults.js';
import { canvaStatus, listDesigns, startVideoExport, exportStatus } from '../../../lib/canva.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MIN_CARDS = 2;
const MAX_CARDS = 10;   // Meta's own limit for a carousel

// Mockups pushed to Meta are named <brand>-<handle>-lifestyle.png (app/api/mockups), which
// is what lets a library image be traced back to its product.
const MOCKUP_SUFFIX = '-lifestyle.png';
// Where a picture may come from to be copied into the ad image library: our Blob store
// (Drafts), Shopify's CDN and Printify's mockup host.
const PICTURE_HOSTS = /(^[a-z0-9]+\.public\.blob\.vercel-storage\.com|(^|\.)cdn\.shopify\.com|(^|\.)images-api\.printify\.com|(^|\.)images\.printify\.com)$/i;
function handleFromName(brand, name) {
  const n = String(name || '');
  if (!n.startsWith(brand + '-') || !n.endsWith(MOCKUP_SUFFIX)) return null;
  return n.slice(brand.length + 1, -MOCKUP_SUFFIX.length) || null;
}

const namePrefix = creativeNamePrefix;

function checkBrand(brand) {
  if (!brand || !configuredShopifyBrands().includes(brand) || !metaAccountFor(brand)) {
    throw new Error('No ad account is configured for ' + brand + '.');
  }
  return brand;
}

const pageFor = pageForBrand;
const identity = adIdentity;

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
    canva: await canvaStatus().catch(() => ({ configured: false, connected: false, designs: false })),
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
      // Also, for picking by product: units sold (best sellers), the Printify mockups per
      // colour (to make a lifestyle shot from), and the mockups already in Drafts.
      const [images, products, shopUrl, sold, index, drafts] = await Promise.all([
        listAdImages(brand),
        listActiveProducts(brand).catch(() => []),
        shopPrimaryUrl(brand).catch(() => ''),
        bestSellers(brand).catch((err) => { console.error('[ads] best sellers', err); return null; }),
        printifyMockupIndex(brand, { staleOk: true }).catch(() => null),
        listDrafts({ kinds: ['mockup'], brand, limit: 600 }).catch(() => []),
      ]);
      if (index && index.stale) after(() => printifyMockupIndex(brand, { force: true }).catch(() => {}));
      const byHandle = new Map(products.map((p) => [p.handle, p]));
      const draftsByHandle = {};
      // Every mockup in Drafts, newest first, for the picker's "Recent mockups" tab: shots
      // made without a product are there too, which "By product" cannot show.
      const recent = drafts.filter((d) => d.output && d.output.url).slice(0, 200).map((d) => {
        const h = (d.source && d.source.handle) || '';
        const p = h ? byHandle.get(h) : null;
        return {
          id: d.id, url: d.output.url, handle: h, productId: p ? p.id : (d.source && d.source.productId) || null,
          title: (p && p.title) || (d.source && d.source.title) || d.title || '', color: (d.source && d.source.color) || '',
          side: (d.source && d.source.side) || (/,\s*back$/i.test((d.source && d.source.color) || '') ? 'back' : null),
          favorite: d.status === 'favorite', at: d.updatedAt || d.createdAt,
          check: d.source && d.source.check ? { pass: d.source.check.pass, score: d.source.check.score } : null,
        };
      });
      for (const d of drafts) {
        const h = d.source && d.source.handle;
        if (!h || !d.output || !d.output.url) continue;
        (draftsByHandle[h] = draftsByHandle[h] || []).push({
          id: d.id, url: d.output.url, color: d.source.color || '', favorite: d.status === 'favorite',
          side: d.source.side || (/,\s*back$/i.test(d.source.color || '') ? 'back' : null),
          check: d.source.check ? { pass: d.source.check.pass, score: d.source.check.score } : null, at: d.updatedAt || d.createdAt,
        });
      }
      return NextResponse.json({
        shopUrl,
        sold: Boolean(sold),
        drafts: draftsByHandle,
        recent,
        products: products.map((p) => {
          const m = mockupsFor(index, p.skus);
          return {
            id: p.id, handle: p.handle, title: p.title, image: p.image, createdAt: p.createdAt, productType: p.productType,
            collections: p.collections, sold: sold ? sold[p.legacyId] || 0 : null,
            // Printify's flat mockups per colour, the best thing to make a scene from.
            colors: m ? m.colors.map((c) => ({ name: c.name, hex: c.hex, front: c.front, back: c.back || null })) : [],
            defaultColor: m ? m.defaultColor : null,
            hasBack: Boolean(m && m.hasBack),
          };
        }),
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

    // A picture that is not in the ad image library yet (a mockup in Drafts, a store photo)
    // copied into it, so a carousel can use it. Only our own Blob store, Shopify's and
    // Printify's image hosts are fetched. Picking it is the approval, the same line the
    // Mockups tab draws: the library is the list of approved pictures.
    if (body.action === 'url-to-meta') {
      const brand = checkBrand(body.brand);
      let target;
      try { target = new URL(String(body.url || '')); } catch { /* below */ }
      if (!target || target.protocol !== 'https:' || !PICTURE_HOSTS.test(target.hostname)) throw new Error('That picture is not from Drafts or the store.');
      const res = await fetch(target);
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) throw new Error('Could not fetch the picture.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error('That picture is too large for Meta.');
      const handle = String(body.handle || 'image').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80);
      // Lifestyle shots get the name the library filter and product titles key on.
      const name = brand + '-' + handle + (body.lifestyle ? MOCKUP_SUFFIX : '-product.png');
      const image = await uploadAdImage(brand, buf.toString('base64'), name);
      return NextResponse.json({ ...image, name, handle: body.lifestyle ? handle : null, mockup: Boolean(body.lifestyle) });
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

    // ---- video from Canva ----
    if (body.action === 'plan-video') {
      const brand = checkBrand(body.brand);
      const plans = await planVideos({
        brand, brandName: BRANDS[brand].name,
        assets: Array.isArray(body.assets) ? body.assets : [],
        aspect: body.aspect, notes: body.notes, beat: body.beat || null,
        previous: Array.isArray(body.previous) ? body.previous : [],
        standing: await adNotesFor(brand).catch(() => ''),
      });
      return NextResponse.json({ plans });
    }

    if (body.action === 'plan-still') {
      const brand = checkBrand(body.brand);
      const plans = await planStills({
        brand, brandName: BRANDS[brand].name,
        assets: Array.isArray(body.assets) ? body.assets : [],
        aspect: body.aspect, notes: body.notes,
        previous: Array.isArray(body.previous) ? body.previous : [],
        standing: await adNotesFor(brand).catch(() => ''),
      });
      return NextResponse.json({ plans });
    }

    if (body.action === 'image-to-meta') {
      const brand = checkBrand(body.brand);
      const b64 = String(body.b64 || '');
      // A rendered JPEG is well under this; the cap keeps the request under Vercel's limit.
      if (!b64 || b64.length > 4 * 1024 * 1024) throw new Error('That image is empty or too large to send.');
      const slug = String(body.title || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'image';
      const image = await uploadAdImage(brand, b64, brand + '-builder-' + slug + '-' + Date.now().toString(36) + '.jpg');
      return NextResponse.json(image);
    }

    if (body.action === 'build-image') {
      const brand = checkBrand(body.brand);
      const hash = String(body.hash || '');
      if (!/^[0-9a-f]{16,64}$/i.test(hash)) throw new Error('Send the image to Meta first.');
      const link = String(body.link || '').trim();
      if (!isUrl(link)) throw new Error('The ad needs a link starting with https://.');
      const who = await identity(brand);
      const label = String(body.name || '').trim() || new Date().toISOString().slice(0, 10);
      const creativeName = namePrefix(brand) + label;
      const result = await createImageCreative(brand, {
        ...who, name: creativeName, hash,
        message: String(body.message || '').trim(),
        headline: String(body.headline || '').trim(),
        link, cta: body.cta,
      });
      // A builder draft remembers its creative, so its results come back to Drafts.
      if (body.draftId) await recordMeta(body.draftId, { creativeId: result.id }, gate.access.email).catch(() => {});
      return NextResponse.json({ ...result, name: creativeName });
    }

    if (body.action === 'canva-designs') {
      return NextResponse.json(await listDesigns({
        query: typeof body.query === 'string' ? body.query.trim() : '',
        continuation: typeof body.continuation === 'string' ? body.continuation : '',
      }));
    }

    if (body.action === 'video-export') {
      return NextResponse.json(await startVideoExport(String(body.designId || ''), { vertical: body.vertical !== false }));
    }

    if (body.action === 'video-export-status') {
      return NextResponse.json(await exportStatus(String(body.exportId || '')));
    }

    if (body.action === 'video-to-meta') {
      const brand = checkBrand(body.brand);
      // Only Canva's own export links, so this cannot be pointed at an arbitrary URL.
      let host = '';
      try { host = new URL(String(body.url || '')).hostname; } catch { /* rejected below */ }
      if (!/(^|\.)canva(-[a-z0-9]+)?\.com$|amazonaws\.com$/i.test(host)) throw new Error('That is not a Canva export link.');
      const slug = String(body.title || 'reel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'reel';
      return NextResponse.json(await uploadAdVideoFromUrl(brand, { url: body.url, name: brand + '-canva-' + slug + '.mp4' }));
    }

    if (body.action === 'video-status') {
      const brand = checkBrand(body.brand);
      if (!/^\d+$/.test(String(body.videoId || ''))) throw new Error('No video to check.');
      return NextResponse.json(await adVideoStatus(brand, String(body.videoId)));
    }

    if (body.action === 'build-video') {
      const brand = checkBrand(body.brand);
      const videoId = String(body.videoId || '');
      if (!/^\d+$/.test(videoId)) throw new Error('Send the video to Meta first.');
      const link = String(body.link || '').trim();
      if (!isUrl(link)) throw new Error('The ad needs a link starting with https://.');
      // Re-read rather than trusting a thumbnail URL from the client.
      const status = await adVideoStatus(brand, videoId);
      if (status.status !== 'ready') throw new Error('Meta is still processing the video. Try again in a moment.');
      const who = await identity(brand);
      const label = String(body.name || '').trim() || new Date().toISOString().slice(0, 10);
      const creativeName = namePrefix(brand) + label;
      const result = await createVideoCreative(brand, {
        ...who,
        name: creativeName,
        videoId,
        thumbnail: status.thumbnail,
        message: String(body.message || '').trim(),
        headline: String(body.headline || '').trim(),
        link,
        cta: body.cta,
      });
      if (body.draftId) await recordMeta(body.draftId, { creativeId: result.id, videoId }, gate.access.email).catch(() => {});
      return NextResponse.json({ ...result, name: creativeName });
    }

    // Read-only diagnosis of what the Meta token can do for this brand.
    if (body.action === 'check-access') {
      const brand = checkBrand(body.brand);
      const { page } = await pageFor(brand).catch(() => ({ page: null }));
      const instagram = page ? await resolveInstagram(brand, page.id).catch(() => null) : null;
      return NextResponse.json(await checkMetaAccess(brand, { pageId: page && page.id, instagramId: instagram && instagram.id }));
    }

    if (body.action === 'collections') {
      const brand = checkBrand(body.brand);
      return NextResponse.json({ collections: await listCollections(brand) });
    }

    if (body.action === 'landing-page') {
      const brand = checkBrand(body.brand);
      const title = String(body.title || '').trim().slice(0, 255);
      const handles = Array.isArray(body.handles) ? [...new Set(body.handles.map(String))] : [];
      if (!title) throw new Error('The landing page needs a title.');
      if (!handles.length) throw new Error('Pick at least one product for the landing page.');
      if (handles.length > 50) throw new Error('A landing page holds at most 50 products.');
      // Resolve handles server side, so only this store's live products can go in.
      const byHandle = new Map((await listActiveProducts(brand)).map((p) => [p.handle, p.id]));
      const missing = handles.filter((h) => !byHandle.has(h));
      if (missing.length) throw new Error('Not active products in this store: ' + missing.join(', '));
      // The "also like" collection must be one of this store's, checked here.
      let alsoLikeId = null;
      if (body.alsoLike) {
        const found = (await listCollections(brand)).find((c) => c.id === String(body.alsoLike));
        if (!found) throw new Error('That "you might also like" collection is not in this store.');
        alsoLikeId = found.id;
      }
      return NextResponse.json(await createLandingCollection(brand, {
        title, productIds: handles.map((h) => byHandle.get(h)), alsoLikeId,
      }));
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
      const ad = await createPausedAd(brand, { adsetId, creativeId, name });
      if (body.draftId) await recordMeta(body.draftId, { creativeId, adId: ad.id, adSetId: adsetId }, gate.access.email).catch(() => {});
      return NextResponse.json(ad);
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
      const who = await identity(brand);
      const shopUrl = await shopPrimaryUrl(brand).catch(() => '');
      const label = String(body.name || '').trim() || new Date().toISOString().slice(0, 10);
      const creativeName = namePrefix(brand) + label;
      const result = await createCarouselCreative(brand, {
        ...who,
        name: creativeName,
        message: String(body.message || '').trim(),
        // The carousel's main link (primary text, end card, "See more"): its landing page
        // when one was made, else the store. Each card keeps its own product link.
        link: isUrl(body.mainLink) ? String(body.mainLink).trim() : isUrl(shopUrl) ? shopUrl : clean[0].link,
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
