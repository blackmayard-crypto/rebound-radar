CREATE TABLE members (
  member_id TEXT PRIMARY KEY,
  stripe_customer TEXT UNIQUE,
  checkout_key TEXT,
  checkout_plan TEXT,
  checkout_expires INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(member_id),
  expires INTEGER NOT NULL
);

CREATE TABLE verified_invoices (
  invoice_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  payment_intent_id TEXT NOT NULL
);

CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
