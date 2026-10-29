-- ============================================================
-- Patch 028b: Add Booking Workflow Enum Values
-- ============================================================

ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'awaiting_payment';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'cancelled_unpaid';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'active_rental';
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'completed';
