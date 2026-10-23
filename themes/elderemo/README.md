# Elder Emo theme files

Hand-pasted, like everything under `themes/`. Nothing here is deployed from this repo,
and the live theme is not edited from code: themes differ per store and the risk is not
worth it. Paste into an unpublished duplicate, preview, then publish.

Elder Emo runs Shopify's **Horizon**.

## `templates/collection.landing.json`

The "You might also like" landing page template for the Ads tab. See the Ads tab in
Backstage for the per-store setup steps, and the Landing pages section of `CLAUDE.md`.

## `snippets/market-collection-empty.liquid`

Hides collections that are empty in the buyer's market.

**The problem it solves.** Collections are not per-market in Shopify. They publish to
sales channels only, never to a market catalog, so a collection exists in every market
and renders with whatever products that market can actually buy. Because Canada and
Australia hold only locally printed listings, and the UK nothing shipped in, a lot of
collections now render as empty pages that still return HTTP 200: **26 in Australia and
21 in the UK** as of 2026-10-23. Buyers can land on them from navigation and Google can
index them.

There is no API fix. Market catalogs hold no collections, so the only lever is the theme.

**Two places to use it**, both small edits:

1. **Navigation**, so empty collections do not appear in menus. Wherever the header or
   footer loops over `linklists`, guard each collection link:

   ```liquid
   {%- for link in section.settings.menu.links -%}
     {%- capture is_empty -%}
       {%- if link.type == 'collection_link' -%}
         {%- render 'market-collection-empty', col: link.object -%}
       {%- endif -%}
     {%- endcapture -%}
     {%- unless is_empty == 'true' -%}
       ... the existing link markup ...
     {%- endunless -%}
   {%- endfor -%}
   ```

   Nested menus need the same guard on `link.links`.

2. **The collection page itself**, so Google does not index an empty one. In
   `layout/theme.liquid`, inside `<head>`:

   ```liquid
   {%- if template.name == 'collection' -%}
     {%- capture is_empty -%}{%- render 'market-collection-empty', col: collection -%}{%- endcapture -%}
     {%- if is_empty == 'true' -%}<meta name="robots" content="noindex, follow">{%- endif -%}
   {%- endif -%}
   ```

   `noindex, follow` rather than a redirect or a 404: the page becomes full again the
   moment that market gains a matching product, and a redirect would have to be undone.

**Not verified on a storefront.** This was written against Horizon and the live behaviour
of `products_count` under Markets, which was confirmed by fetching collection pages per
market (`/collections/crops` renders fully at the root and empty under `/en-au`), but the
snippet itself has not been run in a theme. Preview it in a duplicate before publishing.

**Seven collections are empty in every market**, including the US: `halloween`,
`halloween-kids`, `halloween-adults`, `halloween-totes-treat-or-treat-bags`,
`halloween-pets`, `gift-cards` and `are-you-even-emo-uk-pre-order`. The snippet hides
those everywhere, which is probably right, but Halloween is a week away as of writing, so
check whether they are about to be filled before concluding the snippet has misfired.
