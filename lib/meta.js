// Pushes an approved mockup into a brand's Meta ad account image library.
//
// Library only, and that boundary is deliberate. This makes the image available to use
// in an ad. It does not create a creative, does not create or run an ad, does not touch
// a budget, and shows nothing to anyone. It is the Meta equivalent of attaching an image
// to a Shopify product: the asset is in place, a human still decides what to do with it.
// If write tools ever grow here, weigh them against that, not against convenience.
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

export function metaConfigured(brand) {
  return Boolean(process.env.META_ACCESS_TOKEN && metaAccountFor(brand));
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

  if (!res.ok || !data || data.error) {
    const err = (data && data.error) || {};
    const code = err.code;
    // Name the two failures you will actually hit, rather than passing through a
    // Graph error that reads the same for every cause.
    if (code === 190) {
      throw new Error('Meta rejected the access token. It has probably expired: issue a new ' +
        'system user token with ads_management and update META_ACCESS_TOKEN.');
    }
    if (code === 200 || code === 368 || code === 272) {
      throw new Error('Meta denied access to ad account ' + accountId + '. The token needs ' +
        'ads_management permission on that account. It said: ' + (err.message || 'no detail'));
    }
    throw new Error('Meta upload failed (' + res.status + '): ' +
      (err.message || JSON.stringify(data || {}).slice(0, 300)));
  }

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
