-- Backstage store.
-- Each inbound support email becomes one inquiry row after the pipeline processes it.

CREATE TABLE IF NOT EXISTS inquiries (
  id            BIGSERIAL PRIMARY KEY,
  gmail_id      TEXT UNIQUE NOT NULL,          -- dedupe key so we never process a message twice
  brand         TEXT NOT NULL,                 -- elderemo | poppunks | ayee | wallspoke | unknown
  from_email    TEXT NOT NULL,
  to_email      TEXT,                          -- original recipient we routed on
  subject       TEXT,
  received_at   TIMESTAMPTZ NOT NULL,

  is_support    BOOLEAN NOT NULL DEFAULT TRUE,
  issue_type    TEXT,                          -- "Where is my order", "Damaged item", ...
  summary       TEXT,                          -- one line
  body          TEXT,                          -- original email text
  order_number  TEXT,

  order_status  JSONB,                         -- resolved line-item ledger (see lib/fulfillment.js)
  needs_action  BOOLEAN NOT NULL DEFAULT FALSE,
  draft_reply   TEXT,
  confidence    REAL,

  status        TEXT NOT NULL DEFAULT 'open',  -- open | resolved
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_open ON inquiries (status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_brand ON inquiries (brand);

-- Proactive at-risk orders (snapshot, rewritten on each scan).
CREATE TABLE IF NOT EXISTS risk_orders (
  order_id          TEXT PRIMARY KEY,
  brand             TEXT NOT NULL,
  order_number      TEXT,
  customer_name     TEXT,
  customer_email    TEXT,
  items             TEXT,
  reasons           JSONB,
  rule_key          TEXT,
  severity          TEXT NOT NULL DEFAULT 'medium',  -- high | medium
  age_days          INT,
  shopify_admin_url TEXT,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_severity ON risk_orders (severity, age_days DESC);

-- Manually cleared risk orders (persist until a new kind of problem appears).
CREATE TABLE IF NOT EXISTS risk_dismissals (
  order_id     TEXT PRIMARY KEY,
  rule_key     TEXT,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which at-risk orders have already been announced to Slack. Separate from risk_orders
-- because that table is deleted and rewritten on every scan, so a notified flag stored
-- there would be lost and every order would re-alert six times a day. Keyed by rule_key
-- like risk_dismissals, so a NEW kind of problem on an already-announced order re-alerts.
CREATE TABLE IF NOT EXISTS risk_notifications (
  order_id    TEXT PRIMARY KEY,
  rule_key    TEXT,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Product builder + editable settings =====

-- Printify stores for the product builder. brand_key links a store to its shared voice.
CREATE TABLE IF NOT EXISTS stores (
  brand_key         TEXT PRIMARY KEY,        -- elderemo | poppunks | ...
  name              TEXT NOT NULL,
  printify_shop_id  TEXT NOT NULL,
  is_default        BOOLEAN NOT NULL DEFAULT false
);

-- Per-store, per-garment price + tags for the builder.
CREATE TABLE IF NOT EXISTS product_config (
  brand_key    TEXT NOT NULL,
  garment_key  TEXT NOT NULL,               -- gildan_tee | comfort_colors_tee | tank | womens_tee | crop | hoodie
  price_cents  INT NOT NULL,
  tags         TEXT,                         -- comma separated
  PRIMARY KEY (brand_key, garment_key)
);

-- One shared brand voice per brand, used by BOTH product descriptions and CS reply drafts.
CREATE TABLE IF NOT EXISTS brand_voices (
  brand_key  TEXT PRIMARY KEY,
  voice      TEXT NOT NULL
);

-- Editable global settings (e.g. the CS reply structure) as key/value.
CREATE TABLE IF NOT EXISTS app_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- ===== OAuth for the remote MCP server =====
-- Claude connects to /api/mcp from Anthropic's servers, and its connector UI only accepts
-- OAuth (or no auth), so the app has to be its own authorization server. Public clients
-- with PKCE throughout: no client secrets are issued. Tokens are stored as SHA-256
-- hashes, so a database leak does not hand over live credentials.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,          -- S256 only
  scope          TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,   -- short, single use
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,            -- access | refresh
  client_id    TEXT NOT NULL,
  scope        TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens (expires_at);

-- ===== Who is allowed to sign in =====
-- Google login replaced the single shared password. Access is an allowlist: signing in
-- with Google proves who you are, this table decides whether you get in. Two roles only,
-- and the only thing 'admin' unlocks is managing this table.
CREATE TABLE IF NOT EXISTS allowed_users (
  email      TEXT PRIMARY KEY,          -- lowercased Google account address
  role       TEXT NOT NULL DEFAULT 'member',  -- admin | member
  name       TEXT,                      -- from Google, filled in on first sign-in
  added_by   TEXT,
  last_seen  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Email tab (lib/klaviyo.js) =====
-- Klaviyo's flow report allows 2 requests a minute and 225 a day per account, so every
-- Klaviyo answer is cached here rather than in memory, where a cold function would
-- forget it and spend the limit again. Keys are built in lib/klaviyo.js.
CREATE TABLE IF NOT EXISTS klaviyo_cache (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscriber count per brand per day. Klaviyo only answers "how many now", so the total
-- over time exists only if we write it down; the daily cron and every tab load do.
CREATE TABLE IF NOT EXISTS email_list_snapshots (
  brand       TEXT NOT NULL,          -- brand key: elderemo | poppunks | wallspoke
  day         DATE NOT NULL,          -- in the Klaviyo account's timezone
  subscribers INTEGER NOT NULL,
  segment_id  TEXT,                   -- which segment was counted, in case it changes
  PRIMARY KEY (brand, day)
);

-- ===== Traffic tab (lib/traffic.js) =====
-- ShopifyQL answers per brand and date range, cached so period switching and reloads do
-- not re-run six analytics queries per brand. Same shape as klaviyo_cache.
CREATE TABLE IF NOT EXISTS insights_cache (
  key        TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Brand kit (Settings, per brand) =====
-- Files the video builder reuses on every ad: end card images, transparent logos, brand
-- fonts and approved music. The files live in Vercel Blob (BLOB_READ_WRITE_TOKEN, public
-- store "backstage-brand-kit"); this table is the list of them. Kept until someone
-- deletes one in Settings, which removes the file too. `meta` holds what the browser
-- measured at upload: width/height for images, seconds/bpm/period/offset for music.
-- The lowest sort_order of a kind is that brand's default.
CREATE TABLE IF NOT EXISTS brand_assets (
  id           SERIAL PRIMARY KEY,
  brand_key    TEXT NOT NULL,
  kind         TEXT NOT NULL,                 -- endcard | logo | font | music
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  pathname     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   BIGINT,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_assets_brand_idx ON brand_assets (brand_key, kind, sort_order);

-- ===== Inspiration (competitor ads and phone captures) =====
-- Backstage fetches competitors' Meta ads itself (lib/adLibrary.js, ScrapeCreators, daily
-- cron /api/inspiration-refresh) and keeps them here. It replaced the Competitor Ads sheet
-- the Mac scheduled task filled; the sheet's competitors, stars and notes were imported
-- once on first load (lib/inspiration.js, importFromSheet).
CREATE TABLE IF NOT EXISTS competitors (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  page_id     TEXT NOT NULL UNIQUE,      -- the Facebook Page id the Ad Library knows them by
  active      BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT NOT NULL DEFAULT '',
  checked_at  TIMESTAMPTZ,               -- last fetch attempt
  last_error  TEXT,
  capped      BOOLEAN NOT NULL DEFAULT false, -- more live ads than one run reads
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ad (Meta's ad_archive_id). `media` holds our own copies in Vercel Blob,
-- saved the first time the ad is seen, because Meta's media links expire within days;
-- `media_source` keeps Meta's latest links until that has worked. `impression_rank` is
-- the ad's place in the Ad Library's own impressions order for its Page on the last run
-- (1 = most seen), the only reach signal Meta gives for US commercial ads.
CREATE TABLE IF NOT EXISTS competitor_ads (
  ad_id            TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL,
  competitor       TEXT NOT NULL,
  headline         TEXT NOT NULL DEFAULT '',
  body             TEXT NOT NULL DEFAULT '',
  link_url         TEXT,
  cta              TEXT,
  display_format   TEXT,
  start_date       DATE,
  end_date         DATE,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  active           BOOLEAN NOT NULL DEFAULT true,
  collation_id     TEXT,
  collation_count  INTEGER,
  impression_rank  INTEGER,
  media            JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_source     JSONB,
  media_saved      BOOLEAN NOT NULL DEFAULT false,
  media_tries      INTEGER NOT NULL DEFAULT 0,
  starred          BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS competitor_ads_page_idx ON competitor_ads (page_id, active);
CREATE INDEX IF NOT EXISTS competitor_ads_media_idx ON competitor_ads (media_saved) WHERE media_saved = false;

-- Screenshots and screen recordings sent from a phone: the iPhone Share sheet Shortcut
-- (/api/inspiration/capture, presigned upload) or the tab's own upload button. Files in
-- Vercel Blob under inspiration/captures/.
CREATE TABLE IF NOT EXISTS inspiration_captures (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,          -- image | video
  url           TEXT NOT NULL,
  pathname      TEXT NOT NULL UNIQUE,
  content_type  TEXT,
  size_bytes    BIGINT,
  competitor    TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'upload',   -- upload | shortcut
  starred       BOOLEAN NOT NULL DEFAULT false,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per fetch run, for the tab's "last checked" line and the credit count.
CREATE TABLE IF NOT EXISTS inspiration_runs (
  id           SERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  checked      INTEGER NOT NULL DEFAULT 0,
  new_ads      INTEGER NOT NULL DEFAULT 0,
  ended_ads    INTEGER NOT NULL DEFAULT 0,
  media_saved  INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  credits_left INTEGER,
  errors       TEXT
);

-- What Claude read off a capture (lib/inspiration.js, readCapture): the advertiser named on
-- the Facebook or Instagram ad, platform, Sponsored, and its visible headline, button and
-- copy. read_at marks it read once, so a capture is never sent twice.
ALTER TABLE inspiration_captures ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE inspiration_captures ADD COLUMN IF NOT EXISTS read_info JSONB;

-- Which of our stores a competitor matters for (brand keys). Empty means all of them.
-- The Inspiration tab filters by it and opens a breakdown on that store.
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS brands TEXT[] NOT NULL DEFAULT '{}';

-- ===== Drafts (mockups, video ads, image ads) =====
-- Everything the creative tools make is kept here until someone deletes it, so work
-- survives closing the tab and shows on any device. `kind` is mockup | video | image.
-- `status` is draft | favorite. A video or image draft keeps its `plan` (the builder's own
-- plan, lib/adPlans.js / lib/stillPlans.js) and the `assets` it uses (our copies in Blob),
-- so it can be reopened and edited; `output` is the rendered file once there is one.
-- `files` lists every Blob URL the draft owns, removed with it. `source` says where it
-- came from: the product and scene of a mockup, or the inspiration ad it recreates.
CREATE TABLE IF NOT EXISTS creative_drafts (
  id          SERIAL PRIMARY KEY,
  brand       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  title       TEXT NOT NULL DEFAULT '',
  plan        JSONB,
  assets      JSONB NOT NULL DEFAULT '[]'::jsonb,
  output      JSONB,
  source      JSONB NOT NULL DEFAULT '{}'::jsonb,
  files       TEXT[] NOT NULL DEFAULT '{}',
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_drafts_list_idx ON creative_drafts (brand, kind, status, updated_at DESC);

-- Inspiration batches (lib/recreate.js): picked competitor ads, each made into our own
-- mockups, an ad draft and a server render. `items` holds each ad's progress; a worker
-- holds `lease_until` while it works, and an expired lease means it can be restarted.
CREATE TABLE IF NOT EXISTS creative_batches (
  id SERIAL PRIMARY KEY,
  brand TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',     -- running | done | failed | stopped
  options JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  lease_until TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS creative_batches_recent_idx ON creative_batches (created_at DESC);

-- Competitors read off phone captures are added before anyone has found their Ad Library
-- Page, so page_id may be empty until then (fetching skips those). UNIQUE still holds for
-- the ones that have one.
ALTER TABLE competitors ALTER COLUMN page_id DROP NOT NULL;

-- The creative MCP connection (/api/mcp/creative) acts as the person who approved it, so
-- codes and tokens carry that email; the customer-service connection ignores it.
ALTER TABLE oauth_codes ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS user_email TEXT;

-- Looking up a capture-found competitor's Ad Library Page (lib/adLibrary.js
-- findCompetitorPage): the candidates kept when no Page matched the name exactly, and when
-- it was tried, so it is tried once.
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS page_candidates JSONB;
ALTER TABLE competitors ADD COLUMN IF NOT EXISTS page_looked_up_at TIMESTAMPTZ;

-- Estimated spend of the creative tools (lib/spend.js): one row per paid image and per
-- server render, tagged with the batch and draft when there is one.
CREATE TABLE IF NOT EXISTS spend_events (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                 -- image | render
  brand TEXT,
  batch_id INT,
  draft_id INT,
  units NUMERIC NOT NULL DEFAULT 1,   -- images, or render seconds
  cost_usd NUMERIC NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spend_events_month_idx ON spend_events (created_at);
CREATE INDEX IF NOT EXISTS spend_events_batch_idx ON spend_events (batch_id);

-- ===== Brief templates =====
-- Saved briefs for the Inspiration tab's brief editor (lib/recreate.js, saveBriefTemplate):
-- the idea, direction, headlines, make, shape, layout, overlays, scene, composition and
-- what to avoid, without products, kept per store by name.
CREATE TABLE IF NOT EXISTS brief_templates (
  id          SERIAL PRIMARY KEY,
  brand       TEXT NOT NULL,
  name        TEXT NOT NULL,
  brief       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand, name)
);
