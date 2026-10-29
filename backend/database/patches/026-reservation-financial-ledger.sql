-- Keep payment and deposit records available from reservation confirmation,
-- before a rental contract exists. Existing records are linked through rentals.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS reservation_id uuid
    REFERENCES reservations (id) ON DELETE RESTRICT;

UPDATE payments p
SET reservation_id = r.reservation_id
FROM rentals r
WHERE p.rental_id = r.id
  AND p.reservation_id IS NULL;

ALTER TABLE payments
    ALTER COLUMN reservation_id SET NOT NULL,
    ALTER COLUMN rental_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_reservation
    ON payments (reservation_id, paid_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_manual_reference_by_reservation
    ON payments (reservation_id, type, reference)
    WHERE reference IS NOT NULL;

ALTER TABLE security_deposits
    ADD COLUMN IF NOT EXISTS reservation_id uuid
    REFERENCES reservations (id) ON DELETE RESTRICT;

ALTER TABLE security_deposits
    DISABLE TRIGGER trg_security_deposits_updated_at;

UPDATE security_deposits d
SET reservation_id = r.reservation_id
FROM rentals r
WHERE d.rental_id = r.id
  AND d.reservation_id IS NULL;

ALTER TABLE security_deposits
    ENABLE TRIGGER trg_security_deposits_updated_at;

ALTER TABLE security_deposits
    ALTER COLUMN reservation_id SET NOT NULL,
    ALTER COLUMN rental_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_security_deposit_reservation
    ON security_deposits (reservation_id);

CREATE OR REPLACE FUNCTION reject_payment_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Payment ledger records are append-only';
END; $$;

DROP TRIGGER IF EXISTS trg_payments_append_only ON payments;
CREATE TRIGGER trg_payments_append_only
    BEFORE UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION reject_payment_mutation();

CREATE OR REPLACE FUNCTION protect_financial_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.action IN (
        'FINANCIAL_PAYMENT_RECORDED',
        'SECURITY_DEPOSIT_RECEIVED',
        'SECURITY_DEPOSIT_SETTLED',
        'FINANCIAL_CHARGE_RECORDED',
        'FINANCIAL_INVOICE_ISSUED'
    ) THEN
        RAISE EXCEPTION 'Financial audit records are immutable';
    END IF;
    RETURN OLD;
END; $$;

DROP TRIGGER IF EXISTS trg_financial_audit_immutable ON audit_logs;
CREATE TRIGGER trg_financial_audit_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION protect_financial_audit_log();
