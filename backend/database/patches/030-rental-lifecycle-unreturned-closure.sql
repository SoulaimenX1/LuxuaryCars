-- Patch 030: Allow administrative closure of invalid/voided rentals that were never physically returned
ALTER TABLE rentals DROP CONSTRAINT IF EXISTS chk_rental_lifecycle;
ALTER TABLE rentals ADD CONSTRAINT chk_rental_lifecycle CHECK (
       (status = 'active'   AND returned_at IS NULL     AND closed_at IS NULL)
    OR (status = 'returned' AND returned_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed'   AND closed_at IS NOT NULL)
);
