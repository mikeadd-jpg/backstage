# Backstage

Multi-brand customer-service triage for three Shopify merch stores (Elder Emo,
PopPunks, Wallspoke), plus a proactive at-risk order scan and a Printify product
builder. Next.js 15 App Router, plain JavaScript, Postgres on Neon, deployed on
Vercel. `middleware.js` gates the entire app behind one shared password
(`APP_PASSWORD`), exempting only `/login`, `/api/login`, and the two cron endpoints.

Read `README.md` for setup. This file covers the decisions and traps that are not
obvious from any single file.

## Entry points

Two crons in `vercel.json`, both exempt from the password gate because they carry
their own auth:

| Route | Schedule | Auth |
| --- | --- | --- |
| `/api/ingest` | every 20 min | GET: `x-vercel-cron` header or `Authorization: Bearer $CRON_SECRET`. POST: `x-ingest-key: $INGEST_SECRET` |
| `/api/scan` | every 4 hours | same |

Both accept either GET form on purpose: Vercel only sends the Bearer token when a
`CRON_SECRET` env var exists, so checking it alone would 401 every scheduled run.

## Ingest pipeline (`lib/pipeline.js`)

Order matters and is deliberate:

1. `listMessageIds()` is one cheap Gmail call.
2. `filterUnprocessed()` dedupes against `inquiries.gmail_id` **before** any body
   fetch, because `fetchMessagesByIds` costs one API call per message.
3. Only `MAX_PER_RUN = 8` messages are fully processed, under a
   `TIME_BUDGET_MS = 45000` guard, inside `maxDuration = 60`. Leftovers are not an
   error: the next run picks them up. Do not raise these without checking the
   function time limit and the Gmail quota.
4. Brand routing, classify, order lookup, draft, insert.

Brand routing (`lib/brands.js`) reads the **original** recipient, which forwarding
hides. It tries `delivered-to`, `x-original-to`, `x-forwarded-to`, `to`, `cc`, then
scans the forwarded body as a last resort. If routing fails, `resolveOrderAcrossBrands`
uses the order number as the clue: whichever store owns the order *is* the brand.

## Shopify (`lib/shopify.js`)

Shopify is the source of truth for every order regardless of who fulfills it.

Auth is the **client credentials grant**, not a permanent `shpat_` token. Apps created
in the Shopify Dev Dashboard (the only option since Jan 1 2026) have no permanent
token, so we exchange `*_SHOPIFY_CLIENT_ID` + `*_SHOPIFY_CLIENT_SECRET` for a
short-lived token and cache it in-module per brand. Env holds no Shopify token.

`brandConfig().shopify.token` in `lib/brands.js` reads a `*_SHOPIFY_TOKEN` var that no
longer exists. It is a dead leftover of the old auth model. Only `.domain` is used.

`buildLedger()` maps each line item to `shipped` / `production` / `action`, using
`fulfillment_service` to decide the fulfiller (`manual` means you ship it). `action`
means a human on the team must do something, not a vendor delay.

## Vendor drill-downs

Called only for line items whose ledger status is `production`, and only from
`lib/fulfillment.js`. All three are best-effort: they swallow their own errors so the
Shopify status still stands.

Each matches its order back to Shopify on a different key. These are the fragile part:

- Printify: `metadata.shop_order_id`
- Gelato: `orderReferenceId`
- Printful: `external_id` (Wallspoke; the risk scan checks both order id and order name)

## Risk scan (`lib/risk.js`)

Thresholds live in `RISK_DAYS`. Manual-unshipped and vendor problems are `high`,
everything else `medium`.

Two rules that exist because of past bugs, do not "simplify" them away:

- An empty or unknown `shipment_status` is **never** flagged. Shopify frequently leaves
  it empty even on delivered orders, which produced a wave of false positives. Only the
  statuses in `IN_TRANSIT` count as in-transit.
- Dismissals are keyed by `ruleKey`, a sorted join of the reason ids. Clearing an order
  hides it only for that same set of reasons, so a new kind of problem re-surfaces it.
  `pruneDismissals` drops dismissals for orders that are no longer flagged at all.

## Brand voice is shared

`brand_voices` in Postgres drives **both** the CS reply drafts (`lib/classify.js`) and
the Printify product descriptions (`lib/builder.js`). The `VOICES` constants in
`lib/brands.js` are only the fallback when the DB row is missing. Editing a voice in
Settings changes how both outputs sound.

The reply skeleton is `REPLY_STRUCTURE` in `lib/brands.js`, overridable by the
`cs_reply_structure` row in `app_settings`.

**No em dashes or en dashes, ever.** `GLOBAL_STYLE` instructs the model and
`stripDashes()` in `lib/classify.js` enforces it on the output regardless. Keep both;
the prompt alone is not reliable.

Models come from `CLASSIFY_MODEL` (cheap, Haiku) and `DRAFT_MODEL` (Sonnet).

## Product builder image handling

Printify rasterizes an uploaded SVG **at the pixel size the file's own header declares**
and stores it as a PNG, so uploading a vector buys you no resolution. Designs exported
at 155x85 became 155x85 print files that Printify then upscaled to fill the print area.

`prepareImage()` in `lib/builder.js` therefore rasterizes SVG server-side with `sharp`,
scaling librsvg's `density` so the long edge lands at `RASTER_LONG_EDGE` (4800px, 300
DPI over a 16 inch print area; override with `BUILDER_RASTER_PX`). Raster uploads pass
through untouched, since upscaling a PNG adds no detail, and warn below 2400px.

Two consequences to keep in mind:

- We now own the rasterizing, so **live `<text>` in an SVG renders with the server's
  fonts, not yours.** `prepareImage` warns when it sees a `<text>` element. Converting
  text to outlines before upload is the fix, and is Printify's own guidance anyway.
- `sharp` is declared in `package.json` rather than leaned on as a Next.js transitive
  dep. Next treats it as a server-external package by default, so no bundler config.

## Kids builder (`lib/kids.js`)

Separate from the adult builder because Printify Choice (provider 99) cannot fulfil the
kids blueprints for UK and Canada, so **every region names its own print provider**. One
design produces 14 draft products. `KIDS_CATALOG` is the single source of truth; it was
verified against the live catalog on 2026-08-28.

Unlike `lib/builder.js`, variant ids are **not** hardcoded. A kids garment has a
different variant set per provider (the toddler tee is 18 colors in the US, 8 in the UK),
so the catalog stores colour *names* and `resolveVariants()` maps them to ids at build
time. That self-heals when Printify changes stock. The palettes are the intersection
across each garment's regions, so listings look the same worldwide.

Four irregularities that are real, not bugs:

- **No long-sleeve infant bodysuit on Printify has a UK provider** (blueprints 31, 974,
  2336 all lack one), so `ls_bodysuit` is US and CA only. Its US provider is SwiftPOD
  (39) because Printify Choice does not carry blueprint 31.
- **Bella+Canvas 3001T (blueprint 580) is US-only**, so the UK and CA toddler tee falls
  back to Rabbit Skins 3321 (blueprint 32). One slot, two blueprints.
- **`ls_bodysuit` uses Duplium (41) in Canada, not Print Geek (27)** like the others,
  because Print Geek stocks only 4 variants of it (Navy and Red, no black or white).
- **Print Geek exposes no back print area** on blueprints 33, 34 and 32, so a back design
  is silently dropped for those three CA products, with a warning. `resolveVariants`
  returns the available positions for exactly this reason: never assume `back` exists.

The builder runs in two steps via `/api/kids` (`action: 'prepare'` then one
`action: 'build'` per garment group) because the Vercel Hobby plan caps functions at 60
seconds and 14 sequential creates will not fit in one request. Adding a garment or region
means editing `KIDS_CATALOG` only; Settings picks up the new `garmentKey` automatically
through `kidsGarmentList()`, and `product_config` needs no schema change.

Note the adult builder auto-appends the `upsellprod` tag; the kids builder does not. Kids
tags come entirely from `product_config`.

## Adding a brand

Four places, easy to half-do:

1. `BRANDS` in `lib/brands.js`, plus a `VOICES` entry.
2. Env: `<BRAND>_SHOPIFY_DOMAIN`, `<BRAND>_SHOPIFY_CLIENT_ID`,
   `<BRAND>_SHOPIFY_CLIENT_SECRET`, plus `<BRAND>_PRINTIFY_SHOP_ID` or
   `<BRAND>_PRINTFUL_STORE_ID`. `configuredShopifyBrands()` keys off the first three.
3. `BRANDS` and `RAIL_BRANDS` in `app/page.jsx`, plus color vars in `app/globals.css`.
4. `CS_BRANDS` and `BRAND_NAMES` in `app/Settings.jsx`.

## Database

`db/schema.sql` is applied by hand and there are no migrations. Any column change needs
a matching manual `ALTER TABLE` against Neon. `db/seed.sql` is idempotent
(`ON CONFLICT DO NOTHING`) and safe to re-run.

The ingest cron is 20 minutes rather than 1 so the Neon compute can scale to zero
between runs. Speeding it up costs money.

## Conventions

Plain JavaScript, no TypeScript. No test suite, no linter, no formatter. Every file
opens with a short comment saying what it does and why; match that when adding one.
Components are `.jsx` with `'use client'`, API routes are `route.js` with
`export const dynamic = 'force-dynamic'`.

## Known state

Commit `a9c2ec5` was made from a stale copy of several files and silently reverted
commit `a0620f4`. The resolved-history view, the working sidebar filters, and reopen
are **not** on `main` despite the commit message claiming them: the rail filters in
`app/page.jsx` are inert `div`s, `/api/inquiries` has no `?status=resolved`, and
`lib/db.js` lost `reopenInquiry` / `getResolvedInquiries`. The `resolved_at` column
still exists in the schema but nothing writes it.

This repo lives in iCloud Drive, so a stale working copy is a real failure mode. When a
feature seems missing, check `git log --stat` for a commit that reverted it before
rebuilding from scratch.
