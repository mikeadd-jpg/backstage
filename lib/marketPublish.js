// Puts new products into the Shopify market catalogs their tags name. Elder Emo's market
// catalogs (US, UK, Canada, Australia) have auto-publish off since 2026-10-16, so a product
// the builder makes reaches no market until it is added to the catalogs its market tags
// (us, ca, uk, au; lib/printers.js MARKETS) name. This does that step.
//
// Deliberately narrow:
//   - Only products created since PUBLISH_SINCE. Older products still carry market tags
//     from before the catalogs were pruned (CA and AU hold only the Global Fulfillment
//     listings on purpose), and re-adding those would undo that pruning.
//   - Only adds, never removes.
//   - A preview first; publishing is a click, and the server publishes only what its own
//     fresh preview says is missing, never a list taken on trust from the client.
// Stores without market catalogs (PopPunks, Wallspoke) sell every product everywhere and
// have nothing to do here. Needs read_publications and write_publications on the app.
import { shopifyGraphql } from './shopify.js';
import { MARKETS } from './printers.js';

export const PUBLISH_SINCE = '2026-10-16';
const MAX_PAGES = 10;

const CATALOGS = `{ catalogs(first: 20, type: MARKET) { nodes { id title status
  ... on MarketCatalog { markets(first: 5) { nodes { name regions(first: 10) { nodes { ... on MarketRegionCountry { code } } } } } }
  publication { id } } } }`;

/** The store's active market catalogs that one of our market tags names: [{ tag, title, publicationId }]. */
export async function marketCatalogs(brand) {
  const d = await shopifyGraphql(brand, CATALOGS, {}, { scopeHint: 'Reading market catalogs needs read_publications on the Shopify app (then a redeploy).' });
  const out = [];
  for (const c of d.catalogs.nodes || []) {
    if (c.status !== 'ACTIVE' || !c.publication) continue;
    const codes = (c.markets ? c.markets.nodes : []).flatMap((m) => m.regions.nodes.map((r) => r.code));
    const m = codes.length === 1 && MARKETS.find((x) => x.ship === codes[0]);
    if (m) out.push({ tag: m.tag, title: c.title, publicationId: c.publication.id });
  }
  return out;
}

/** Products since PUBLISH_SINCE whose market tags name a catalog they are not in yet. */
export async function previewMarketPublish(brand) {
  const catalogs = await marketCatalogs(brand);
  if (!catalogs.length) return { catalogs, since: PUBLISH_SINCE, missing: [], checked: 0 };
  const fields = catalogs.map((c, i) => 'p' + i + ': publishedOnPublication(publicationId: "' + c.publicationId + '")').join(' ');
  const q = `query($q: String, $cursor: String) { products(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor } nodes { id title handle tags createdAt ${fields} } } }`;
  const missing = [];
  let cursor = null, checked = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await shopifyGraphql(brand, q, { q: 'status:active created_at:>=' + PUBLISH_SINCE, cursor });
    for (const p of d.products.nodes) {
      checked++;
      const tags = p.tags.map((t) => t.toLowerCase());
      const need = catalogs.map((c, i) => ({ ...c, i })).filter((c) => tags.includes(c.tag) && !p['p' + c.i]);
      if (need.length) missing.push({ id: p.id, title: p.title, handle: p.handle, created: p.createdAt.slice(0, 10), markets: need.map((c) => c.tag), publicationIds: need.map((c) => c.publicationId) });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return { catalogs: catalogs.map(({ tag, title }) => ({ tag, title })), since: PUBLISH_SINCE, missing, checked };
}

const PUBLISH = `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`;

/** Publishes `productIds` (all when omitted) into the catalogs a fresh preview says they are missing from. */
export async function publishToMarkets(brand, productIds = null) {
  const { missing } = await previewMarketPublish(brand);
  const want = productIds ? missing.filter((p) => productIds.includes(p.id)) : missing;
  const done = [], failed = [];
  for (const p of want) {
    const d = await shopifyGraphql(brand, PUBLISH, { id: p.id, input: p.publicationIds.map((publicationId) => ({ publicationId })) },
      { scopeHint: 'Publishing to market catalogs needs write_publications on the Shopify app (then a redeploy).' });
    const errs = d.publishablePublish.userErrors || [];
    if (errs.length) failed.push({ title: p.title, error: errs.map((e) => e.message).join('; ') });
    else done.push({ title: p.title, markets: p.markets });
  }
  return { published: done, failed };
}
