// GET  /api/inspiration   competitors, their ads (with our saved media), phone captures and
//                         the latest fetch run, plus the stores an idea can be adapted for.
// POST /api/inspiration   { action, ... }:
//   analyze          { adId | captureId, brand, image? }  Claude breaks it down and writes
//                    our version's recipe and a Mockups scene. Text only.
//   refresh          fetch competitors' ads now (the daily cron does the same)
//   mark-ad          { id, starred?, notes? }
//   mark-capture     { id, starred?, note?, competitor? }
//   delete-capture   { id }
//   read-capture     { id, frame? }  Claude reads the advertiser and text off a capture
//                    (a video sends a frame); fills its brand if blank
//   add-capture      { url, note?, competitor? }  record a file the tab uploaded
//   save-competitor  { id?, name, pageId, active?, notes?, brands? }  brands: our store
//                    keys it applies to, empty for all. Returns { id }.
//   scan-competitor  { id }  fetch that competitor's ads and media now
//   remove-competitor { id }
//   find-page        { id }  look up a capture-found competitor's Ad Library Page
//   upload-key       make a new key for the iPhone Shortcut (settings area); shown once
//
// Ads and captures are looked up by id here, never taken from the client, so what Claude
// reads is what Backstage holds. Area `inspiration` (owner, admin, creative). Not exposed
// over MCP.
import { NextResponse, after } from 'next/server';
import { head } from '@vercel/blob';
import { requireArea } from '../../../lib/access.js';
import { BRANDS, configuredShopifyBrands } from '../../../lib/brands.js';
import {
  readInspiration, analyzeAd, getAd, getCapture, setAdMark, setCaptureMark, deleteCapture, addCapture,
  saveCompetitor, removeCompetitor, newUploadKey, uploadKeyInfo, CAPTURE_PREFIX, readCapture, markCaptureRead,
} from '../../../lib/inspiration.js';
import { refreshCompetitorAds, findCompetitorPage } from '../../../lib/adLibrary.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // the client shrinks screenshots well under this

const brandsList = () => configuredShopifyBrands().map((b) => ({ key: b, name: BRANDS[b].name }));

export async function GET(req) {
  const gate = await requireArea(req, 'inspiration');
  if (gate.error) return gate.error;
  try {
    const [data, key] = await Promise.all([readInspiration(), uploadKeyInfo()]);
    return NextResponse.json({
      ...data, brands: brandsList(), uploadKey: key, canMakeKey: gate.access.areas.includes('settings'),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err), brands: brandsList() }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'inspiration');
  if (gate.error) return gate.error;
  try {
    const body = await req.json();
    const ok = () => NextResponse.json({ ok: true });

    if (body.action === 'analyze') {
      const brand = body.brand;
      if (!brand || !configuredShopifyBrands().includes(brand)) throw new Error('Pick one of our stores first.');
      let image = null;
      if (body.image) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(String(body.image));
        if (!m || !IMAGE_TYPES.includes(m[1])) throw new Error('The screenshot must be a PNG, JPEG, WebP or GIF.');
        if (m[2].length > MAX_IMAGE_B64) throw new Error('That screenshot is too large. Try a smaller one.');
        image = { mediaType: m[1], data: m[2] };
      }
      let ad, imageUrls = [];
      if (body.captureId) {
        const c = await getCapture(body.captureId);
        if (!c) throw new Error('That capture is gone. Refresh and try again.');
        ad = { competitor: c.competitor || 'an advertiser seen on a phone', headline: '', text: '', active: true, ourNote: c.note,
          format: c.kind === 'video' ? 'VIDEO' : 'IMAGE' };
        if (c.kind === 'image' && !image) imageUrls = [c.url];
        if (c.kind === 'video' && !image) throw new Error('Grab a frame of the recording first.');
      } else {
        const a = await getAd(body.adId);
        if (!a) throw new Error('That ad is no longer in Backstage. Refresh and try again.');
        const media = a.media || [];
        imageUrls = media.filter((m) => m.kind === 'image').map((m) => m.url);
        const v = media.find((m) => m.kind === 'video' && m.poster);
        if (v) imageUrls.unshift(v.poster);
        ad = {
          competitor: a.competitor, headline: a.headline, text: a.body, format: a.display_format, active: a.active,
          startDate: a.start_date ? new Date(a.start_date).toISOString().slice(0, 10) : '',
          days: a.start_date ? Math.round((Date.now() - new Date(a.start_date)) / 86400000) : 0,
          rank: a.impression_rank, copies: a.collation_count || 1, ourNote: a.notes,
        };
      }
      const recipe = await analyzeAd({ ad, brand, brandName: BRANDS[brand].name, image, imageUrls: image ? [] : imageUrls });
      return NextResponse.json({ recipe });
    }

    if (body.action === 'refresh') return NextResponse.json(await refreshCompetitorAds({ budgetMs: 240000 }));

    if (body.action === 'mark-ad') { await setAdMark(body.id, body); return ok(); }
    if (body.action === 'mark-capture') { await setCaptureMark(body.id, body); return ok(); }
    if (body.action === 'delete-capture') { await deleteCapture(body.id); return ok(); }
    if (body.action === 'read-capture') {
      try {
        const r = await readCapture(body.id, body.frame);
        // A brand new to the list: look up its Ad Library Page, and scan it when certain.
        if (r.addedCompetitor) {
          after(async () => {
            const f = await findCompetitorPage(r.addedCompetitor).catch((err) => ({ error: err.message }));
            if (f.pageId) await refreshCompetitorAds({ budgetMs: 200000, competitorId: r.addedCompetitor }).catch(() => {});
          });
        }
        return NextResponse.json(r);
      }
      catch (err) {
        // Unreadable for good (no frame): don't ask again. Anything else retries next load.
        if (/No frame|gone/.test(String(err.message))) await markCaptureRead(body.id).catch(() => {});
        throw err;
      }
    }

    if (body.action === 'add-capture') {
      // Ask Blob rather than trusting the client's url, type or size.
      const info = await head(String(body.url || '')).catch(() => null);
      if (!info || !info.pathname.startsWith(CAPTURE_PREFIX)) throw new Error('The upload did not arrive. Try again.');
      const id = await addCapture({
        url: info.url, pathname: info.pathname, contentType: info.contentType, size: info.size,
        competitor: body.competitor, note: body.note, source: 'upload', by: gate.access.email,
      });
      return NextResponse.json({ id });
    }

    if (body.action === 'save-competitor') {
      const ours = configuredShopifyBrands();
      const brands = Array.isArray(body.brands) ? [...new Set(body.brands.filter((b) => ours.includes(b)))] : undefined;
      return NextResponse.json({ id: await saveCompetitor({ ...body, brands }) });
    }
    if (body.action === 'scan-competitor') {
      if (!body.id) throw new Error('Which competitor?');
      return NextResponse.json(await refreshCompetitorAds({ budgetMs: 240000, competitorId: body.id }));
    }
    if (body.action === 'remove-competitor') { await removeCompetitor(body.id); return ok(); }
    if (body.action === 'find-page') {
      const f = await findCompetitorPage(body.id);
      if (f.pageId) after(() => refreshCompetitorAds({ budgetMs: 200000, competitorId: body.id }).catch(() => {}));
      return NextResponse.json(f);
    }

    if (body.action === 'upload-key') {
      if (!gate.access.areas.includes('settings')) throw new Error('Only an owner or admin can make the Shortcut key.');
      return NextResponse.json({ key: await newUploadKey(gate.access.email) });
    }

    throw new Error('Unknown action.');
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
