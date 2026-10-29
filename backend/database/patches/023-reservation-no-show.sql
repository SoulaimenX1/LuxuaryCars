-- Additive reservation lifecycle change. Historical reservations are retained.
ALTER TYPE reservation_status
  ADD VALUE IF NOT EXISTS 'no_show';

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS no_show_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_reason text;
