// A brand's kit for the video builder: end card images, logos, fonts and approved music,
// kept for good (files in Vercel Blob, the list in brand_assets). Settings manages it;
// the Ads tab reads it.
//
//   GET  ?brand=                                    { assets: [...], style }  (ads or settings)
//   POST { action: 'style', brand, style }          colours, font roles, look, guidelines
//   POST { action: 'add', brand, kind, url, pathname, name, meta }     record an upload
//   POST { action: 'rename', id, name }
//   POST { action: 'default', id }                  first of its kind = the default
//   POST { action: 'delete', id }                   removes the file from Blob too
//
// Writes need the settings area. Not exposed over MCP.
import { NextResponse } from 'next/server';
import { head, del } from '@vercel/blob';
import { requireArea } from '../../../lib/access.js';
import { BRANDS } from '../../../lib/brands.js';
import { KIT_KINDS, kitPrefix } from '../../../lib/kitKinds.js';
import { cleanStyle, styleKey } from '../../../lib/brandStyle.js';
import {
  getSetting, setSetting,
  listBrandAssets, getBrandAsset, addBrandAsset, renameBrandAsset, makeDefaultBrandAsset, deleteBrandAsset,
} from '../../../lib/db.js';

export const dynamic = 'force-dynamic';

async function styleFor(brand) {
  const raw = await getSetting(styleKey(brand));
  if (!raw) return null;
  try { return cleanStyle(JSON.parse(raw)); } catch { return null; }
}

const shape = (r) => ({
  id: r.id, kind: r.kind, name: r.name, url: r.url, contentType: r.content_type,
  size: r.size_bytes ? Number(r.size_bytes) : null, meta: r.meta || {}, by: r.created_by, at: r.created_at,
});

// Only numbers the browser measured, never free-form data, go into meta.
function cleanMeta(kind, m) {
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v) * 1000) / 1000 : undefined);
  const out = {};
  if (kind === 'endcard' || kind === 'logo') { out.width = num(m.width, 1, 20000); out.height = num(m.height, 1, 20000); }
  if (kind === 'music') { out.seconds = num(m.seconds, 0, 7200); out.bpm = num(m.bpm, 40, 260); out.period = num(m.period, 0.1, 2); out.offset = num(m.offset, 0, 600); }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export async function GET(req) {
  const gate = await requireArea(req, ['ads', 'settings']);
  if (gate.error) return gate.error;
  const brand = new URL(req.url).searchParams.get('brand') || '';
  if (!BRANDS[brand]) return NextResponse.json({ error: 'Unknown brand.' }, { status: 400 });
  try {
    const [rows, style] = await Promise.all([listBrandAssets(brand), styleFor(brand)]);
    return NextResponse.json({ assets: rows.map(shape), style, storage: Boolean(process.env.BLOB_READ_WRITE_TOKEN) });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireArea(req, 'settings');
  if (gate.error) return gate.error;
  try {
    const b = await req.json();
    if (b.action === 'style') {
      if (!BRANDS[b.brand]) throw new Error('Unknown brand.');
      const style = cleanStyle(b.style);
      await setSetting(styleKey(b.brand), JSON.stringify(style));
      return NextResponse.json({ style });
    }
    if (b.action === 'add') {
      const kind = KIT_KINDS[b.kind];
      if (!BRANDS[b.brand] || !kind) throw new Error('Unknown brand or kind.');
      const pathname = String(b.pathname || '');
      if (!pathname.startsWith(kitPrefix(b.brand, b.kind))) throw new Error('That file is not in this brand\'s kit.');
      // Ask Blob rather than trusting the client's url, type or size.
      const info = await head(pathname).catch(() => null);
      if (!info) throw new Error('The upload did not arrive. Try again.');
      const name = String(b.name || '').trim().slice(0, 120) || pathname.split('/').pop();
      const row = await addBrandAsset({
        brandKey: b.brand, kind: b.kind, name, url: info.url, pathname: info.pathname,
        contentType: info.contentType, sizeBytes: info.size, meta: cleanMeta(b.kind, b.meta || {}), createdBy: gate.access.email,
      });
      return NextResponse.json({ asset: shape(row) });
    }
    const row = await getBrandAsset(Number(b.id));
    if (!row) throw new Error('That file is no longer in the kit.');
    if (b.action === 'rename') {
      const name = String(b.name || '').trim().slice(0, 120);
      if (!name) throw new Error('Give it a name.');
      await renameBrandAsset(row.id, name);
    } else if (b.action === 'default') {
      await makeDefaultBrandAsset(row.id);
    } else if (b.action === 'delete') {
      // File first: a row whose file is gone would break every video that picks it.
      await del(row.url).catch((err) => { if (!/not.?found/i.test(String(err.message))) throw err; });
      await deleteBrandAsset(row.id);
    } else {
      throw new Error('Unknown action.');
    }
    return NextResponse.json({ assets: (await listBrandAssets(row.brand_key)).map(shape) });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 400 });
  }
}
