# reports/

Point-in-time records of things read out of Shopify or Printify that are worth keeping
but are not code. Like `sheets/` and `themes/`, **nothing here is deployed or read by the
app**: these are notes with a date on them, and they go stale.

Each file says when it was taken. Re-read the live source before acting on one.

| File | What it is |
| --- | --- |
| `elderemo-shipping-profiles.md` | Elder Emo's 89 delivery profiles on 2026-10-15, split into the 51 carrying products and the 38 empty ones, with the product counts that justified deleting the empties. |
| `elderemo-delivery-profiles-backup.json` | The same 89 profiles as returned by the Admin API, taken immediately before those 38 were deleted. Names, ids, product counts and method counts; enough to tell what was removed, not enough to recreate a profile's rates. |

## Why the delete happened

Elder Emo was at 89 delivery profiles against Shopify's limit of 100. 37 of the empty ones
were Gelato profiles for products the store does not sell (canvas, mugs, photo books, phone
cases), which Gelato creates in full when it is connected. Deleting a profile with no
products attached moves nothing, so the 38 came out and the store sits at 51.

Printify and Gelato both add profiles as new product types are published, so this count
climbs on its own. Worth re-checking before a big build.
