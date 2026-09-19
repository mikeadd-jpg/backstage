# Backstage

A standalone dashboard that pulls customer support email from one shared Gmail inbox,
routes each message to the right brand, classifies the issue, resolves order status
(Shopify first, print vendors as a drill-down), drafts a reply, and shows it all as a
card your team can read and copy.

## Pipeline

    Gmail (shared inbox)
      -> brand router        lib/brands.js     original recipient -> brand
      -> classifier          lib/classify.js   is-support? issue type, summary, order #
      -> order lookup        lib/fulfillment.js Shopify source of truth, per line item
           -> Printify        lib/printify.js   only for unshipped Printify items
           -> Gelato          lib/gelato.js     only for unshipped Gelato items
      -> draft reply         lib/classify.js
      -> store               lib/db.js -> Postgres
      -> dashboard           app/page.jsx reads /api/inquiries

## Setup

1. `npm install`
2. Create the database, then load `db/schema.sql`.
3. Copy `.env.example` to `.env.local` and fill in the values (see notes below).
4. `npm run dev` and open http://localhost:3000
   (The dashboard shows sample data until the pipeline has stored real inquiries.)
5. Trigger the pipeline once: `npm run ingest`, or POST to `/api/ingest` with the
   `x-ingest-key` header set to your `INGEST_SECRET`.

## Credential notes

- Gmail: create an OAuth client in Google Cloud, authorize it once against the shared
  inbox, and store the refresh token. The pipeline reads mail with `GMAIL_QUERY`.
- Shopify: one custom app per brand store, Admin API read access to orders and
  fulfillments. Each brand has its own `*_SHOPIFY_DOMAIN` and `*_SHOPIFY_TOKEN`.
- Printify: one API token, plus each brand's Printify shop id. The resolver matches a
  Printify order to a Shopify order via `metadata.shop_order_id`.
- Gelato: one API key. The resolver matches on `orderReferenceId`; confirm that field
  against how your Shopify-Gelato integration tags orders.
- Lifestyle mockups: `OPENAI_API_KEY`, used by the Mockups tab to put a product's own
  storefront image into a scene. Defaults to `gpt-image-2.5-sunburst`, the variant OpenAI
  positions for editing precision. OpenAI gates its image models behind organisation
  verification, so verify the org before the first run. Optional: `MOCKUP_MODEL` to point
  at a different image model, `MOCKUP_INPUT_FIDELITY` which only applies on `gpt-image-1`.
- Meta: `META_ACCESS_TOKEN`, a system user token with `ads_management`, plus
  `<BRAND>_META_AD_ACCOUNT_ID` per brand (the numeric id; a pasted `act_123` is tolerated).
  Used only to upload an approved mockup into that account's ad image library. Optional:
  `META_API_VERSION`, pinned to `v26.0` by default.
- Product scopes: the Mockups tab reads products over Shopify's GraphQL Admin API, so
  each brand's app needs `read_products`, plus `write_products` to attach a generated
  image back to a product. Those are on top of the order scopes the pipeline needs. The
  access token carries its scopes, so after changing them redeploy to force a fresh one.

## Deploy

Runs on Vercel (Next.js native) or Google Cloud Run. On Vercel, add a Cron job that
POSTs to `/api/ingest` every minute or two with the `x-ingest-key` header.

## What to configure for your setup

- `lib/brands.js` — confirm the support addresses per brand.
- Order-number formats per brand (the resolver prefixes with `#` if missing).
- `GMAIL_QUERY` window vs how often the cron runs, so nothing is missed or double-read.
