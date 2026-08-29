-- Backstage builder + settings seed.
-- Safe to run more than once: every insert uses ON CONFLICT DO NOTHING, so it will not
-- overwrite anything you later edit in the Settings tab.
-- Run db/schema.sql first (it creates these tables), then run this.

-- Stores (brand_key links a store to its shared voice)
INSERT INTO stores (brand_key, name, printify_shop_id, is_default) VALUES
  ('elderemo', 'Elder Emo', '16745257', true),
  ('poppunks', 'Pop Punks', '26840424', false)
ON CONFLICT (brand_key) DO NOTHING;

-- Product pricing + tags (prices in cents)
INSERT INTO product_config (brand_key, garment_key, price_cents, tags) VALUES
  ('elderemo', 'gildan_tee',         2699, 'elderemo, adult, base, newarrival, gildan5000'),
  ('elderemo', 'comfort_colors_tee', 3299, 'elderemo, comfort colors, adult, upsellprod, cc1717'),
  ('elderemo', 'tank',               2899, 'elderemo, adult, tank, upsellprod, gildantank'),
  ('elderemo', 'womens_tee',         2899, 'elderemo, adult, women, upsellprod, gildan64000L'),
  ('elderemo', 'crop',               3299, 'ccboxy, elderemo, adult, comfortcolors, upsellprod, womens'),
  ('poppunks', 'gildan_tee',         2699, 'poppunks, adult, base, newarrival, gildan5000'),
  ('poppunks', 'comfort_colors_tee', 3299, 'poppunks, comfort colors, adult, upsellprod, cc1717'),
  ('poppunks', 'tank',               2899, 'poppunks, adult, tank, upsellprod, gildantank'),
  ('poppunks', 'womens_tee',         2899, 'poppunks, adult, women, upsellprod, gildan64000L'),
  ('poppunks', 'crop',               3299, 'ccboxy, poppunks, adult, comfortcolors, upsellprod, womens')
ON CONFLICT (brand_key, garment_key) DO NOTHING;

-- Shared brand voice (drives BOTH product descriptions and CS reply drafts). Edit in Settings.
INSERT INTO brand_voices (brand_key, voice) VALUES
  ('elderemo', 'Dry, deadpan, a little self-deprecating. Scene-literate without trying too hard. Talk to the customer like a friend from the pit, not a marketer. No hype, no exclamation-point spam, no corporate filler. A reference or wink is good when it is earned; a forced one is worse than none. Nostalgic but self-aware, for people who grew up on emo and pop-punk and never fully left.'),
  ('poppunks', 'Loud-hearted but literate. Hype that sounds like a friend hyping a friend, not an ad. Earnest is allowed here; celebrate the scene without irony-poisoning it. Energetic and fan-first, never corny or corporate. Scene-literate, a nod to the music when it lands, never forced.'),
  ('wallspoke', 'Calm and craft-focused, centered on personalized map wall art. Warm, thoughtful, a little sentimental about the meaning behind a place. Helpful and clear, lighter on slang, more about care and quality.')
ON CONFLICT (brand_key) DO NOTHING;

-- ===== Kids builder config (added 2026-08-28) =====
-- One row per kids product the builder can create: garment plus region. Region is part
-- of the key because UK and Canada use their own print providers and their tags differ.
-- PRICES BELOW ARE PLACEHOLDERS. Review them in the Settings tab before publishing.
INSERT INTO product_config (brand_key, garment_key, price_cents, tags) VALUES
  ('elderemo', 'onesie_us', 2499, 'elderemo, kids, onesie, us, rabbitskins4424'),
  ('elderemo', 'onesie_uk', 2499, 'elderemo, kids, onesie, uk, rabbitskins4424'),
  ('elderemo', 'onesie_ca', 2499, 'elderemo, kids, onesie, ca, rabbitskins4424'),
  ('elderemo', 'ls_bodysuit_us', 2699, 'elderemo, kids, longsleeve bodysuit, us, rabbitskins4411'),
  ('elderemo', 'ls_bodysuit_ca', 2699, 'elderemo, kids, longsleeve bodysuit, ca, rabbitskins4411'),
  ('elderemo', 'baby_tee_us', 2399, 'elderemo, kids, baby tee, us, rabbitskins3322'),
  ('elderemo', 'baby_tee_uk', 2399, 'elderemo, kids, baby tee, uk, rabbitskins3322'),
  ('elderemo', 'baby_tee_ca', 2399, 'elderemo, kids, baby tee, ca, rabbitskins3322'),
  ('elderemo', 'toddler_tee_us', 2499, 'elderemo, kids, toddler tee, us, bellacanvas3001t'),
  ('elderemo', 'toddler_tee_uk', 2499, 'elderemo, kids, toddler tee, uk, rabbitskins3321'),
  ('elderemo', 'toddler_tee_ca', 2499, 'elderemo, kids, toddler tee, ca, rabbitskins3321'),
  ('elderemo', 'youth_tee_us', 2599, 'elderemo, kids, youth tee, us, gildan5000b'),
  ('elderemo', 'youth_tee_uk', 2599, 'elderemo, kids, youth tee, uk, gildan5000b'),
  ('elderemo', 'youth_tee_ca', 2599, 'elderemo, kids, youth tee, ca, gildan5000b'),
  ('poppunks', 'onesie_us', 2499, 'poppunks, kids, onesie, us, rabbitskins4424'),
  ('poppunks', 'onesie_uk', 2499, 'poppunks, kids, onesie, uk, rabbitskins4424'),
  ('poppunks', 'onesie_ca', 2499, 'poppunks, kids, onesie, ca, rabbitskins4424'),
  ('poppunks', 'ls_bodysuit_us', 2699, 'poppunks, kids, longsleeve bodysuit, us, rabbitskins4411'),
  ('poppunks', 'ls_bodysuit_ca', 2699, 'poppunks, kids, longsleeve bodysuit, ca, rabbitskins4411'),
  ('poppunks', 'baby_tee_us', 2399, 'poppunks, kids, baby tee, us, rabbitskins3322'),
  ('poppunks', 'baby_tee_uk', 2399, 'poppunks, kids, baby tee, uk, rabbitskins3322'),
  ('poppunks', 'baby_tee_ca', 2399, 'poppunks, kids, baby tee, ca, rabbitskins3322'),
  ('poppunks', 'toddler_tee_us', 2499, 'poppunks, kids, toddler tee, us, bellacanvas3001t'),
  ('poppunks', 'toddler_tee_uk', 2499, 'poppunks, kids, toddler tee, uk, rabbitskins3321'),
  ('poppunks', 'toddler_tee_ca', 2499, 'poppunks, kids, toddler tee, ca, rabbitskins3321'),
  ('poppunks', 'youth_tee_us', 2599, 'poppunks, kids, youth tee, us, gildan5000b'),
  ('poppunks', 'youth_tee_uk', 2599, 'poppunks, kids, youth tee, uk, gildan5000b'),
  ('poppunks', 'youth_tee_ca', 2599, 'poppunks, kids, youth tee, ca, gildan5000b')
ON CONFLICT (brand_key, garment_key) DO NOTHING;
