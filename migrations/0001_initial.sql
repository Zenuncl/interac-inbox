CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  from_name TEXT,
  to_email TEXT,
  reply_to_email TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  reference TEXT,
  is_auto_deposit INTEGER NOT NULL DEFAULT 0,
  user_message TEXT,
  language TEXT,
  subject TEXT,
  body_raw TEXT,
  sender_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unmatched',
  order_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  response_code INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
