// A brand's Meta ad account: push an approved mockup into its image library, list that
// library, build a carousel ad creative from images already in it, and put that creative
// into an existing ad set as a PAUSED ad (the Ads tab).
//
// That is where the write surface stops, deliberately. A creative is an unpublished post,
// and an ad is only ever created paused: neither shows anything to anyone or spends a
// cent until someone switches it on in Ads Manager. Nothing here creates a campaign or an
// ad set, changes a budget or targeting, or activates anything. If write tools ever grow
// past that, weigh them against it, not against convenience. None of it is exposed over
// MCP.
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
// This is the manual override; resolveMetaPage() below finds it without one.
export function metaPageFor(brand) {
  const raw = process.env[brand.toUpperCase() + '_META_PAGE_ID'];
  return raw ? String(raw).trim() : null;
}

// Optional override for the Instagram account shown on Instagram placements. Normally
// resolveInstagram() reads it off the Page; without either, Meta uses the Page's identity.
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

function requireSetup(brand) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN is not set.');
  const accountId = metaAccountFor(brand);
  if (!accountId) {
    throw new Error('No Meta ad account is configured for ' + brand +
      '. Set ' + brand.toUpperCase() + '_META_AD_ACCOUNT_ID to the numeric account id.');
  }
  return { token, accountId };
}

// Which Page a brand's ads post as, without anyone looking up an id. Meta lists the Pages
// an ad account has advertised for (promote_pages) and the Pages the token can act for
// (me/accounts). One ad account can serve several brands (Elder Emo and PopPunks share
// one), so the account alone cannot decide: a Page whose name matches the brand wins, and
// a lone Page is only taken when no other brand shares the account. Anything ambiguous
// returns null with the candidates, and <BRAND>_META_PAGE_ID settles it.
//
// Returns { page: { id, name, source } | null, candidates: [{ id, name }] }.
const pageCache = new Map();      // brand -> { at, value }
const PAGE_CACHE_MS = 10 * 60 * 1000;
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function resolveMetaPage(brand, { brandName, shared = false } = {}) {
  const override = metaPageFor(brand);
  if (override) return { page: { id: override, name: null, source: 'env' }, candidates: [] };

  const hit = pageCache.get(brand);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return hit.value;

  const { token, accountId } = requireSetup(brand);
  const q = new URLSearchParams({ fields: 'id,name', limit: '100', access_token: token });
  const lists = await Promise.all([
    graphGet(GRAPH + '/' + API_VERSION + '/act_' + accountId + '/promote_pages?' + q),
    graphGet(GRAPH + '/' + API_VERSION + '/me/accounts?' + q),
  ]);
  const [promoted, owned] = lists.map(({ res, data }) => (res.ok && data && Array.isArray(data.data) ? data.data : []));
  const seen = new Map();
  for (const p of [...promoted, ...owned]) if (p && p.id && !seen.has(p.id)) seen.set(p.id, { id: p.id, name: p.name || '' });
  const candidates = [...seen.values()];

  const key = squash(brandName || brand);
  const named = candidates.filter((p) => {
    const n = squash(p.name);
    return n && (n.includes(key) || key.includes(n));
  });
  let page = null;
  if (named.length === 1) page = { ...named[0], source: 'name' };
  else if (!named.length && !shared && promoted.length === 1) page = { id: promoted[0].id, name: promoted[0].name || '', source: 'only' };

  const value = { page, candidates };
  // Only a found Page is cached, so fixing the Page side in Meta shows up on the next load.
  if (page) pageCache.set(brand, { at: Date.now(), value });
  return value;
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

// The Instagram account linked to the Page, which is exactly the id instagram_user_id
// wants (the 1784... business account id, not the handle and not the older id Business
// Settings can show). Best-effort: no linked account just means the Page's identity is
// used on Instagram, which is not worth failing a build over.
const igCache = new Map();        // pageId -> { at, value }
export async function resolveInstagram(brand, pageId) {
  const override = metaInstagramFor(brand);
  if (override) return { id: override, username: null, source: 'env' };
  if (!pageId) return null;
  const hit = igCache.get(pageId);
  if (hit && Date.now() - hit.at < PAGE_CACHE_MS) return hit.value;
  const { token } = requireSetup(brand);
  const q = new URLSearchParams({ fields: 'instagram_business_account{id,username}', access_token: token });
  const { res, data } = await graphGet(GRAPH + '/' + API_VERSION + '/' + pageId + '?' + q).catch(() => ({ res: { ok: false }, data: null }));
  const ig = res.ok && data && data.instagram_business_account;
  const value = ig && ig.id ? { id: ig.id, username: ig.username || null, source: 'page' } : null;
  if (value) igCache.set(pageId, { at: Date.now(), value });
  return value;
}

export const CTA_TYPES = ['SHOP_NOW', 'ORDER_NOW', 'BUY_NOW', 'LEARN_MORE', 'SEE_MORE'];

// Builds one carousel creative from images already in the library, by hash. Returns the
// creative id, the unpublished post behind it (what Ads Manager's "Use existing post"
// lists), and a preview link when Meta will give one. No ad, no ad set, no spend.
export async function createCarouselCreative(brand, { pageId, instagramId, name, message, link, cards, cta, reorder, endCard }) {
  const { token, accountId } = requireSetup(brand);
  if (!pageId) throw new Error('No Facebook Page found for ' + brand + ' to post the ad as.');
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
  if (instagramId) spec.instagram_user_id = instagramId;

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

// The account's live ad sets with their campaigns, for choosing where a creative goes.
// Read-only. Deleted and archived ones are left out; paused ones stay, since adding a
// paused ad to a paused ad set is a normal way to stage a launch.
export async function listAdSets(brand) {
  const { token, accountId } = requireSetup(brand);
  const q = new URLSearchParams({
    fields: 'id,name,effective_status,campaign{id,name,objective,effective_status}',
    limit: '200',
    access_token: token,
  });
  let url = GRAPH + '/' + API_VERSION + '/act_' + accountId + '/adsets?' + q;
  const out = [];
  for (let page = 0; page < 5 && url; page++) {
    const { res, data } = await graphGet(url);
    if (!res.ok || !data || data.error) throw metaError(res, data, accountId, 'Could not list the ad sets');
    for (const a of data.data || []) {
      if (['DELETED', 'ARCHIVED'].includes(a.effective_status)) continue;
      const c = a.campaign || {};
      if (['DELETED', 'ARCHIVED'].includes(c.effective_status)) continue;
      out.push({
        id: a.id, name: a.name, status: a.effective_status,
        campaignId: c.id || null, campaignName: c.name || '(no campaign)',
        campaignStatus: c.effective_status || null, objective: c.objective || null,
      });
    }
    url = (data.paging && data.paging.next) || null;
  }
  return out;
}

// Put an existing creative into an existing ad set as a new ad, always PAUSED. The status
// is fixed here, not taken from the caller: switching it on is a human decision made in
// Ads Manager, with the budget and targeting in view.
export async function createPausedAd(brand, { adsetId, creativeId, name }) {
  const { token, accountId } = requireSetup(brand);
  const body = new URLSearchParams();
  body.set('name', name);
  body.set('adset_id', adsetId);
  body.set('creative', JSON.stringify({ creative_id: creativeId }));
  body.set('status', 'PAUSED');
  body.set('access_token', token);
  const res = await fetch(GRAPH + '/' + API_VERSION + '/act_' + accountId + '/ads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error || !data.id) throw metaError(res, data, accountId, 'Meta would not create the ad');
  return { id: data.id, accountId };
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
