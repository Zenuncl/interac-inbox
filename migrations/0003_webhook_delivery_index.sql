-- Speed up the cron retry query (latest attempt per webhook/transaction pair)
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pair
  ON webhook_deliveries(webhook_id, transaction_id, attempt);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
  ON webhook_deliveries(status, created_at);
