// A brand's Meta ad account: push an approved mockup into its image library, list that
// library, and build a carousel ad creative from images already in it (the Ads tab).
//
// That is where the write surface stops, deliberately. A creative is an unpublished
// post: it shows nothing to anyone and spends nothing until someone puts it in an ad set
// and publishes it in Ads Manager. Nothing here creates a campaign, an ad set or an ad,
// or touches a budget. If write tools ever grow past that, weigh them against it, not
// against convenience. None of it is exposed over MCP.
//
// The brand -> ad account mapping is env, not code, because the account names in this
// business do not line up with the brand keys and guessing would push creative into the
// wrong advertiser. `<BRAND>_META_AD_ACCOUNT_ID`, same shape as the Shopify and Printify
// vars next to it.

const GRAPH = 'https://graph.facebook.com';

// Pin the version. An unversioned Graph call resolves to the oldest version still
// alive, which is a slow-moving trap rather than a helpful default. v26.0 is current as
// of September 2026; bump with META_API_VERSION rather than editing this.
const API_VERSION = process.env.META_API_VERSION || 'v26.0';

export function metaAccountFor(brand) {
  const raw = process.env[brand.toUpperCase() + '_META_AD_ACCOUNT_ID'];
  if (!raw) return null;
  // Tolerate the "act_123" form people copy out of Ads Manager URLs.
  return String(raw).trim().replace(/^act_/, '');
}

// The Facebook Page an ad posts as. Required for a creative, not for an image upload.
export function metaPageFor(brand) {
  const raw = process.env[brand.toUpperCase() + '_META_PAGE_ID'];
  return raw ? String(raw).trim() : null;
}

// Optional: the Instagram account to show on Instagram placements. Without it Meta uses
// the Page's identity there.
export function metaInstagramFor(brand) {
  const raw = process.env[brand.toUpperCase() + '_META_INSTAGRAM_ID'];
  return raw ? String(raw).trim() : null;
}

export function metaConfigured(brand) {
  return Boolean(process.env.META_ACCESS_TOKEN && metaAccountFor(brand));
}

// Name the failures you will actually hit, rather than passing through a Graph error
// that reads the same for every cause.
function metaError(res, data, accountId, what) {
  const err = (data && data.error) || {};
  const code = err.code;
  if (code === 190) {
    return new Error('Meta rejected the access token. It has probably expired: issue a new ' +
      'system user token with ads_management and update META_ACCESS_TOKEN.');
  }
  if (code === 200 || code === 368 || code === 272 || code === 10) {
    return new Error('Meta denied access for ad account ' + accountId + '. The token needs ' +
      'ads_management on that account, and for a creative it must also be allowed to ' +
      'create ads for the Page. It said: ' + (err.message || 'no detail'));
  }
  return new Error(what + ' (' + res.status + '): ' +
    (err.error_user_msg || err.message || JSON.stringify(data || {}).slice(0, 300)));
}

function requireSetup(brand, { page = false } = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set.');
  const accountId = metaAccountFor(brand);
  if (!accountId) {
    throw new Error('No Meta ad account is configured for ' + brand +
      '. Set ' + brand.toUpperCase() + '_META_AD_ACCOUNT_ID to the numeric account id.');
  }
  const pageId = metaPageFor(brand);
  if (page && !pageId) {
    throw new Error('No Facebook Page is configured for ' + brand + '. Set ' +
      brand.toUpperCase() + '_META_PAGE_ID to the Page the ads post as.');
  }
  return { token, accountId, pageId };
}

async function graphGet(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  return { res, data };
}

// Every image in the ad account, newest first. Paged, because the library holds far more
// than one page and the mockups are rarely on the first. Deleted images are dropped.
export async function listAdImages(brand, { maxPages = 8 } = {}) {
  const { token, accountId } = requireSetup(brand);
  const params = new URLSearchParams({
    fields: 'hash,name,url,width,height,created_time,status',
    limit: '100',
    access_token: token,
  });
  let url = GRAPH + '/' + API_VERSION + '/act_' + accountId + '/adimages?' + params;
  const out = [];
  for (let page = 0; page < maxPages && url; page++) {
    const { res, data } = await graphGet(url);
    if (!res.ok || !data || data.error) throw metaError(res, data, accountId, 'Could not list the ad images');
    for (const img of data.data || []) {
      if (img.status && img.status !== 'ACTIVE') continue;
      out.push({
        hash: img.hash, name: img.name || '', url: img.url || null,
        width: img.width || null, height: img.height || null, created: img.created_time || null,
      });
    }
    url = (data.paging && data.paging.next) || null;
  }
  out.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  return out;
}

export const CTA_TYPES = ['SHOP_NOW', 'ORDER_NOW', 'BUY_NOW', 'LEARN_MORE', 'SEE_MORE'];

// Builds one carousel creative from images already in the library, by hash. Returns the
// creative id, the unpublished post behind it (what Ads Manager's "Use existing post"
// lists), and a preview link when Meta will give one. No ad, no ad set, no spend.
export async function createCarouselCreative(brand, { name, message, link, cards, cta, reorder, endCard }) {
  const { token, accountId, pageId } = requireSetup(brand, { page: true });
  const type = CTA_TYPES.includes(cta) ? cta : 'SHOP_NOW';
  const spec = {
    page_id: pageId,
    link_data: {
      link,
      message: message || '',
      child_attachments: cards.map((c) => ({
        link: c.link,
        image_hash: c.hash,
        name: c.headline,
        ...(c.description ? { description: c.description } : {}),
        call_to_action: { type, value: { link: c.link } },
      })),
      // Off by default: the person chose the order, and Meta reshuffling it by
      // performance is a choice they should make, not one made for them.
      multi_share_optimized: Boolean(reorder),
      multi_share_end_card: Boolean(endCard),
    },
  };
  const ig = metaInstagramFor(brand);
  if (ig) spec.instagram_user_id = ig;

  const body = new URLSearchParams();
  body.set('name', name);
  body.set('object_story_spec', JSON.stringify(spec));
  body.set('access_token', token);
  const res = await fetch(GRAPH + '/' + API_VERSION + '/act_' + accountId + '/adcreatives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error || !data.id) throw metaError(res, data, accountId, 'Meta would not create the carousel');

  // Both best-effort: the creative exists either way, and saying so matters more.
  let postId = null;
  let previewUrl = null;
  try {
    const q = new URLSearchParams({ fields: 'effective_object_story_id', access_token: token });
    const r = await graphGet(GRAPH + '/' + API_VERSION + '/' + data.id + '?' + q);
    postId = (r.data && r.data.effective_object_story_id) || null;
  } catch { /* the creative still stands */ }
  try {
    const q = new URLSearchParams({ ad_format: 'MOBILE_FEED_STANDARD', access_token: token });
    const r = await graphGet(GRAPH + '/' + API_VERSION + '/' + data.id + '/previews?' + q);
    const html = (r.data && r.data.data && r.data.data[0] && r.data.data[0].body) || '';
    const m = html.match(/src="([^"]+)"/);
    if (m) previewUrl = m[1].replace(/&amp;/g, '&');
  } catch { /* no preview, not a failure */ }

  return { id: data.id, postId, previewUrl, accountId };
}

// Carousels built here, found by the name prefix the route gives them. One ad account
// can serve two brands, so the brand name is part of the prefix.
export async function listBuiltCreatives(brand, prefix) {
  const { token, accountId } = requireSetup(brand);
  const q = new URLSearchParams({
    fields: 'id,name,thumbnail_url,effective_object_story_id',
    limit: '100',
    access_token: token,
  });
  const { res, data } = await graphGet(GRAPH + '/' + API_VERSION + '/act_' + accountId + '/adcreatives?' + q);
  if (!res.ok || !data || data.error) throw metaError(res, data, accountId, 'Could not list creatives');
  return (data.data || [])
    .filter((c) => String(c.name || '').startsWith(prefix))
    .slice(0, 20)
    .map((c) => ({ id: c.id, name: c.name, thumb: c.thumbnail_url || null, postId: c.effective_object_story_id || null }));
}

// Returns { hash, url, width, height, accountId }. The hash is what an ad creative
// references later, so it is the part worth surfacing and keeping.
export async function uploadAdImage(brand, b64, name) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set, so nothing can be sent to Meta.');

  const accountId = metaAccountFor(brand);
  if (!accountId) {
    throw new Error('No Meta ad account is configured for ' + brand +
      '. Set ' + brand.toUpperCase() + '_META_AD_ACCOUNT_ID to the numeric account id.');
  }
  if (!b64) throw new Error('No image to send.');

  const body = new URLSearchParams();
  body.set('bytes', b64);              // documented as a base64 UTF-8 string
  body.set('name', name || 'lifestyle-' + Date.now() + '.png');
  body.set('access_token', token);

  const res = await fetch(GRAPH + '/' + API_VERSION + '/act_' + accountId + '/adimages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) throw metaError(res, data, accountId, 'Meta upload failed');

  // The response keys `images` by the name it assigned, which we did not choose, so take
  // whatever single entry came back rather than looking up by our own filename.
  const entry = Object.values(data.images || {})[0];
  if (!entry || !entry.hash) throw new Error('Meta accepted the upload but returned no image hash.');

  return {
    hash: entry.hash,
    url: entry.url || null,
    width: entry.width || null,
    height: entry.height || null,
    accountId,
  };
}
