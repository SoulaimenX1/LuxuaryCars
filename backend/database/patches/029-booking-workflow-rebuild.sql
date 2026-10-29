-- ============================================================
-- Patch 029: Complete Booking & Payment Rebuild
-- ============================================================

-- 1. Add workflow tracking columns to reservations
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS payment_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_session_id varchar(255),
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id varchar(255),
  ADD COLUMN IF NOT EXISTS stripe_refund_id varchar(255),
  ADD COLUMN IF NOT EXISTS payment_url text,
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS handover_at timestamptz,
  ADD COLUMN IF NOT EXISTS handover_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS handover_inspection jsonb,
  ADD COLUMN IF NOT EXISTS return_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS return_inspection jsonb,
  ADD COLUMN IF NOT EXISTS deposit_refund_status varchar(50) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS deposit_refunded_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_retained_amount numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deposit_retention_reason text;

-- 3. Update exclusion constraint to prevent overlapping bookings for all active booking statuses
ALTER TABLE reservations
  DROP CONSTRAINT IF EXISTS ex_res_no_double_booking;

ALTER TABLE reservations
  ADD CONSTRAINT ex_res_no_double_booking
  EXCLUDE USING gist (vehicle_id WITH =, period WITH &&)
  WHERE (status = ANY (ARRAY[
    'pending'::reservation_status,
    'awaiting_payment'::reservation_status,
    'confirmed'::reservation_status,
    'active_rental'::reservation_status,
    'converted'::reservation_status
  ]));

-- 4. Update availability trigger functions
CREATE OR REPLACE FUNCTION public.trg_reservation_vs_unavailability()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IN ('pending', 'awaiting_payment', 'confirmed', 'active_rental', 'converted') THEN
    PERFORM 1 FROM vehicles WHERE id = NEW.vehicle_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM vehicle_unavailability u
      WHERE u.vehicle_id = NEW.vehicle_id
        AND u.period && tstzrange(NEW.pickup_at, NEW.return_at, '[)')
    ) THEN
      RAISE EXCEPTION 'Vehicle % is unavailable during the requested period', NEW.vehicle_id
        USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_unavailability_vs_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM vehicles WHERE id = NEW.vehicle_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.vehicle_id = NEW.vehicle_id
      AND r.status IN ('pending', 'awaiting_payment', 'confirmed', 'active_rental', 'converted')
      AND r.period && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'Vehicle % has reservations during this period', NEW.vehicle_id
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$function$;

-- 5. Webhook idempotency and audit table
CREATE TABLE IF NOT EXISTS stripe_processed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  event_type varchar(100) NOT NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_event_id ON stripe_processed_events(event_id);
CREATE INDEX IF NOT EXISTS idx_reservations_payment_deadline ON reservations(payment_deadline_at) WHERE status = 'awaiting_payment';
