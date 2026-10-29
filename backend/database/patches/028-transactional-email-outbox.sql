-- Transactional email outbox enhancements: idempotency keys, retry/backoff state, and notification linkage.
ALTER TABLE customer_email_outbox
  ADD COLUMN IF NOT EXISTS event_key varchar(180),
  ADD COLUMN IF NOT EXISTS template_type varchar(40),
  ADD COLUMN IF NOT EXISTS recipient_email varchar(255),
  ADD COLUMN IF NOT EXISTS notification_id uuid REFERENCES user_notifications(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_email_outbox_event_key
  ON customer_email_outbox (customer_id, event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_email_outbox_dispatch
  ON customer_email_outbox (status, next_attempt_at, created_at)
  WHERE status = 'pending';
