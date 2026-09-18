// Shopify is the source of truth. Every order flows through it regardless of who
// fulfills the item, so we read status here first and only drill into a print vendor
// when an item is still unshipped.
//
// Auth note: apps created in the Shopify Dev Dashboard (the only option since Jan 1,
// 2026) do not have a permanent shpat_ token. Instead we exchange the app's client id
// and secret for a short-lived access token via the client credentials grant, and
// cache it until just before it expires. You only store CLIENT_ID and CLIENT_SECRET.

const API_VERSION = '2026-07';

// In-memory token cache, keyed by brand: { token, expiresAt }.
const tokenCache = {};

function creds(brand) {
  const up = brand.toUpperCase();
  return {
    domain: process.env[up + '_SHOPIFY_DOMAIN'],
    clientId: process.env[up + '_SHOPIFY_CLIENT_ID'],
    clientSecret: process.env[up + '_SHOPIFY_CLIENT_SECRET'],
  };
}

async function getAccessToken(brand) {
  const cached = tokenCache[brand];
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const { domain, clientId, clientSecret } = creds(brand);
  if (!domain || !clientId || !clientSecret) {
    throw new Error('Missing Shopify client credentials for brand ' + brand);
  }

  const res = await fetch('https://' + domain + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Shopify token exchange failed for ' + brand + ': ' + res.status + ' ' + text);
  }
  const data = await res.json();
  tokenCache[brand] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
  return tokenCache[brand].token;
}

async function shopify(brand, path, params = {}) {
  const { domain } = creds(brand);
  if (!domain) throw new Error('Missing Shopify domain for brand ' + brand);
  const token = await getAccessToken(brand);

  const url = new URL('https://' + domain + '/admin/api/' + API_VERSION + '/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error('Shopify ' + res.status + ' for ' + path);
  return res.json();
}

// Find an order by its name (e.g. "#EE-10428") or, failing that, by customer email.
export async function findOrder(brand, { orderNumber, email }) {
  if (orderNumber) {
    const name = orderNumber.startsWith('#') ? orderNumber : '#' + orderNumber;
    const { orders } = await shopify(brand, 'orders.json', { name, status: 'any' });
    if (orders && orders.length) return orders[0];
  }
  if (email) {
    const { orders } = await shopify(brand, 'orders.json', { email, status: 'any', limit: 1 });
    if (orders && orders.length) return orders[0];
  }
  return null;
}

// List recent orders for a store (for the proactive risk scan). Includes fulfillments.
export async function listRecentOrders(brand, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { orders } = await shopify(brand, 'orders.json', {
    status: 'any',
    created_at_min: since,
    limit: 250,
  });
  return orders || [];
}

// Map a Shopify line item + its fulfillments to our normalized ledger row.
// fulfillment_service is the clean signal: "manual" means you ship it, anything else
// ("printify", "gelato", a shipping app) tells us which vendor owns it.
export function buildLedger(order) {
  const fulfillments = order.fulfillments || [];

  const byLineItem = {};
  for (const f of fulfillments) {
    for (const li of f.line_items || []) {
      byLineItem[li.id] = {
        shipmentStatus: f.shipment_status || f.status,
        tracking: (f.tracking_numbers && f.tracking_numbers[0]) || null,
        trackingUrl: (f.tracking_urls && f.tracking_urls[0]) || null,
        company: f.tracking_company || null,
      };
    }
  }

  return (order.line_items || []).map((li) => {
    const svc = (li.fulfillment_service || 'manual').toLowerCase();
    const fulfiller = svc === 'manual' ? 'you' : svc;
    const fInfo = byLineItem[li.id];

    let status;
    if (li.fulfillment_status === 'fulfilled' || (fInfo && fInfo.tracking)) status = 'shipped';
    else if (fulfiller === 'you') status = 'action';
    else status = 'production';

    return {
      lineItemId: li.id,
      name: li.title + (li.variant_title ? ' (' + li.variant_title + ')' : ''),
      sku: li.sku || null,
      quantity: li.quantity,
      fulfiller,
      status,
      tracking: fInfo ? fInfo.tracking : null,
      trackingUrl: fInfo ? fInfo.trackingUrl : null,
    };
  });
}

// =====================================================================================
// Products, for the lifestyle mockup builder.
//
// These go through the GraphQL Admin API rather than REST like the order functions
// above. Shopify made the REST product endpoints legacy and points new apps at GraphQL
// for anything product shaped, so the order code stays on REST where it still works and
// anything new starts where Shopify is heading.
//
// Scopes: read_products to list, write_products to attach an image. The access token
// carries its scopes with it, so after changing them in the Dev Dashboard you have to
// redeploy (or wait out the token cache) before the new scopes reach this code.
// =====================================================================================

async function shopifyGraphql(brand, query, variables = {}) {
  const { domain } = creds(brand);
  if (!domain) throw new Error('Missing Shopify domain for brand ' + brand);
  const token = await getAccessToken(brand);

  const res = await fetch('https://' + domain + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('Shopify GraphQL ' + res.status + ' for ' + brand + ': ' + (await res.text()));

  const json = await res.json();
  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message).join('; ');
    // The scope error is the one you will actually hit, so name the fix rather than
    // making someone decode "Access denied for products field".
    if (/access denied|not approved|scope/i.test(msg)) {
      throw new Error(
        'Shopify denied the product request for ' + brand + '. The app needs read_products, ' +
        'plus write_products to attach an image. Add the scope in the Shopify Dev Dashboard, ' +
        'then redeploy so a fresh token is issued. Shopify said: ' + msg
      );
    }
    throw new Error('Shopify GraphQL error for ' + brand + ': ' + msg);
  }
  return json.data;
}

const PRODUCT_PAGE = `
  query MockupProducts($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        productType
        featuredImage { url }
      }
    }
  }`;

// Active products, most recently updated first. Anything without a featured image is
// dropped: there is nothing for the mockup generator to work from.
export async function listActiveProducts(brand, maxPages = 4) {
  const out = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const { products } = await shopifyGraphql(brand, PRODUCT_PAGE, { cursor });
    for (const p of products.nodes) {
      if (!p.featuredImage || !p.featuredImage.url) continue;
      out.push({
        id: p.id,                          // gid://shopify/Product/123
        legacyId: p.id.split('/').pop(),   // for building admin links
        title: p.title,
        handle: p.handle,
        productType: p.productType || '',
        image: p.featuredImage.url,
      });
    }
    if (!products.pageInfo.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
  }
  return out;
}

const STAGE_UPLOAD = `
  mutation StageMockup($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`;

const CREATE_MEDIA = `
  mutation AttachMockup($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { ... on MediaImage { id image { url } } }
      mediaUserErrors { field message }
    }
  }`;

// Attach a generated mockup to a product. GraphQL only accepts a URL, never raw bytes,
// so the image goes to Shopify's staging bucket first and the media record points at it.
export async function addProductImage(brand, productId, b64, altText) {
  const fileName = 'lifestyle-' + Date.now() + '.png';
  const bytes = Buffer.from(b64, 'base64');

  const staged = await shopifyGraphql(brand, STAGE_UPLOAD, {
    input: [{
      filename: fileName, mimeType: 'image/png', httpMethod: 'POST',
      resource: 'IMAGE', fileSize: String(bytes.length),
    }],
  });
  const stageErrs = staged.stagedUploadsCreate.userErrors || [];
  if (stageErrs.length) throw new Error('Shopify refused the upload: ' + stageErrs.map((e) => e.message).join('; '));

  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('Shopify returned no upload target.');

  // The signed parameters have to be appended before the file or the bucket rejects it.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: 'image/png' }), fileName);

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error('Upload to Shopify staging failed (' + up.status + ').');

  const created = await shopifyGraphql(brand, CREATE_MEDIA, {
    productId,
    media: [{ originalSource: target.resourceUrl, alt: altText || 'Lifestyle mockup', mediaContentType: 'IMAGE' }],
  });
  const mediaErrs = created.productCreateMedia.mediaUserErrors || [];
  if (mediaErrs.length) throw new Error('Shopify rejected the image: ' + mediaErrs.map((e) => e.message).join('; '));

  // Shopify processes media asynchronously, so the CDN url is often still null here.
  const media = created.productCreateMedia.media[0];
  return { id: media ? media.id : null, url: media && media.image ? media.image.url : null };
}
