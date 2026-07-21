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
  order_number  TEXT,

  order_status  JSONB,                         -- resolved line-item ledger (see lib/fulfillment.js)
  needs_action  BOOLEAN NOT NULL DEFAULT FALSE,
  draft_reply   TEXT,
  confidence    REAL,

  status        TEXT NOT NULL DEFAULT 'open',  -- open | resolved
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
  reasons           JSONB,
  severity          TEXT NOT NULL DEFAULT 'medium',  -- high | medium
  age_days          INT,
  shopify_admin_url TEXT,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_severity ON risk_orders (severity, age_days DESC);
