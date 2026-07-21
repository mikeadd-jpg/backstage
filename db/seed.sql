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
