CREATE TABLE IF NOT EXISTS guest_claim_rate_limit (
  minute_bucket INTEGER NOT NULL,
  client_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (minute_bucket, client_hash)
);

CREATE INDEX IF NOT EXISTS guest_claim_rate_limit_bucket_idx
  ON guest_claim_rate_limit (minute_bucket);
