// Same-origin copy of an image from a brand's Meta ad library, for the Ads tab's video
// builder. The browser renderer draws every frame onto a canvas, and Meta's CDN sends no
// CORS headers, so an image loaded straight from it would taint the canvas and the render
// would fail. Only Meta's and Shopify's image hosts are fetched, so this cannot be used
// to proxy arbitrary URLs. Nothing is kept.
import { requireArea } from '../../../../lib/access.js';

export const dynamic = 'force-dynamic';

const HOSTS = /(^|\.)(fbcdn\.net|facebook\.com|cdninstagram\.com|cdn\.shopify\.com)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

export async function GET(req) {
  const gate = await requireArea(req, 'ads');
  if (gate.error) return gate.error;
  let target;
  try { target = new URL(new URL(req.url).searchParams.get('url') || ''); } catch { /* below */ }
  if (!target || target.protocol !== 'https:' || !HOSTS.test(target.hostname)) {
    return new Response('Not an ad library image.', { status: 400 });
  }
  const res = await fetch(target, { redirect: 'follow' }).catch(() => null);
  const type = (res && res.headers.get('content-type')) || '';
  if (!res || !res.ok || !type.startsWith('image/')) return new Response('Could not fetch the image.', { status: 502 });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return new Response('Image too large.', { status: 413 });
  return new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' } });
}
