-- Backstage CS triage store.
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
  garment_key  TEXT NOT NULL,               -- gildan_tee | comfort_colors_tee | tank | womens_tee | crop
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
