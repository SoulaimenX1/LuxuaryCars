-- Migration 027 (compatibility-adjusted): Professional Vehicle Returns
-- This patch is additive/idempotent and compatible with pre-existing legacy schemas.
-- It only makes missing changes; it does not drop, truncate or alter existing data.

-- 1) Add missing column to rentals as required by 027
ALTER TABLE rentals
    ADD COLUMN IF NOT EXISTS return_fee_policy_snapshot jsonb;

-- 2) Ensure inspections allow NULL mileage/fuel where needed for return flows
ALTER TABLE inspections
    ALTER COLUMN mileage_km DROP NOT NULL;

ALTER TABLE inspections
    ALTER COLUMN fuel_level_pct DROP NOT NULL;

-- 3) Update trigger function for inspection mileage to be compatible with existing expectations
CREATE OR REPLACE FUNCTION trg_inspection_mileage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    handover_exists boolean;
    start_km integer;
BEGIN
    IF NEW.type = 'return' THEN
        SELECT EXISTS (
            SELECT 1 FROM inspections
            WHERE rental_id = NEW.rental_id AND type = 'handover'
        ), (
            SELECT mileage_km FROM inspections
            WHERE rental_id = NEW.rental_id AND type = 'handover'
            LIMIT 1
        )
        INTO handover_exists, start_km;

        IF NOT handover_exists THEN
            RAISE EXCEPTION 'A handover inspection is required before the return inspection';
        END IF;

        IF NEW.mileage_km IS NOT NULL AND start_km IS NOT NULL
           AND NEW.mileage_km < start_km THEN
            RAISE EXCEPTION 'Return mileage (%) is lower than handover mileage (%)', NEW.mileage_km, start_km;
        END IF;
    END IF;

    RETURN NEW;
END; $$;

-- Ensure trigger exists and is bound
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'trg_inspections_mileage' 
        AND tgrelid = 'public.inspections'::regclass
        AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER trg_inspections_mileage
            BEFORE INSERT ON inspections
            FOR EACH ROW EXECUTE FUNCTION trg_inspection_mileage();
    END IF;
END $$;

-- 4) Ensure sequences exist
CREATE SEQUENCE IF NOT EXISTS vehicle_return_reference_seq;
CREATE SEQUENCE IF NOT EXISTS vehicle_preparation_reference_seq;

-- 4b) Ensure return and preparation tables exist on fresh schemas while remaining a no-op on existing databases
CREATE TABLE IF NOT EXISTS vehicle_returns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference varchar(24) NOT NULL UNIQUE
        DEFAULT ('RET-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('vehicle_return_reference_seq')::text, 6, '0')),
    rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
    vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
    customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    scenario varchar(16) NOT NULL CHECK (scenario IN ('AGENCY', 'COLLECTION')),
    collection_id uuid,
    collection_mission_id uuid REFERENCES transport_missions(id),
    scheduled_return_at timestamptz NOT NULL,
    actual_return_at timestamptz,
    return_location_id uuid REFERENCES rental_locations(id),
    return_address jsonb,
    responsible_employee_id uuid REFERENCES users(id),
    status varchar(28) NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'vehicle_received',
            'inspection_in_progress',
            'inspection_completed',
            'additional_info_required',
            'management_review',
            'disputed',
            'rejected_correction',
            'validated',
            'pending_settlement',
            'closed'
        )
    ),
    inspection_id uuid REFERENCES inspections(id),
    condition_comparison jsonb NOT NULL DEFAULT '{}'::jsonb,
    new_damage_found boolean NOT NULL DEFAULT false,
    missing_accessories boolean NOT NULL DEFAULT false,
    missing_keys boolean NOT NULL DEFAULT false,
    fuel_discrepancy boolean NOT NULL DEFAULT false,
    mileage_discrepancy boolean NOT NULL DEFAULT false,
    is_late boolean NOT NULL DEFAULT false,
    overdue_minutes integer CHECK (overdue_minutes IS NULL OR overdue_minutes >= 0),
    financial_review_flag boolean NOT NULL DEFAULT false,
    delay_reference varchar(32),
    management_review boolean NOT NULL DEFAULT false,
    dispute boolean NOT NULL DEFAULT false,
    dispute_reason text,
    incident_id uuid,
    customer_tenant_present boolean NOT NULL DEFAULT false,
    customer_acknowledged boolean NOT NULL DEFAULT false,
    customer_ack_at timestamptz,
    decision_notes text,
    decided_by uuid REFERENCES users(id),
    decided_at timestamptz,
    validated_by uuid REFERENCES users(id),
    validated_at timestamptz,
    closed_by uuid REFERENCES users(id),
    closed_at timestamptz,
    request_fingerprint varchar(160),
    awaiting_preparation boolean NOT NULL DEFAULT true,
    preparation_released_at timestamptz,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_agency_return_location CHECK (return_location_id IS NOT NULL OR return_address IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS return_inspections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL UNIQUE REFERENCES vehicle_returns(id) ON DELETE CASCADE,
    rental_id uuid NOT NULL REFERENCES rentals(id) ON DELETE RESTRICT,
    inspection_id uuid REFERENCES inspections(id),
    mileage_km integer CHECK (mileage_km IS NULL OR mileage_km >= 0),
    fuel_level_pct smallint CHECK (fuel_level_pct IS NULL OR (fuel_level_pct >= 0 AND fuel_level_pct <= 100)),
    exterior_condition condition_rating,
    interior_condition condition_rating,
    tires_condition condition_rating,
    glass_condition condition_rating,
    mechanical_warnings boolean NOT NULL DEFAULT false,
    mechanical_notes text,
    cleanliness condition_rating,
    accessories_ok boolean NOT NULL DEFAULT true,
    accessories_notes text,
    keys_returned boolean NOT NULL DEFAULT false,
    keys_count smallint CHECK (keys_count IS NULL OR keys_count >= 0),
    photos jsonb NOT NULL DEFAULT '[]'::jsonb,
    inspector_notes text,
    submitted_at timestamptz,
    submitted_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_damages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL REFERENCES vehicle_returns(id) ON DELETE CASCADE,
    vehicle_zone varchar(60) NOT NULL,
    description text NOT NULL,
    severity varchar(16) NOT NULL CHECK (severity IN ('minor', 'moderate', 'major')),
    pre_existing boolean NOT NULL DEFAULT false,
    reference_inspection_id uuid REFERENCES inspections(id),
    incident_id uuid,
    incident_damage_id uuid,
    photo_path text,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    reviewed_by uuid REFERENCES users(id),
    reviewed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS return_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id uuid NOT NULL REFERENCES vehicle_returns(id) ON DELETE CASCADE,
    inspection_id uuid REFERENCES inspections(id) ON DELETE CASCADE,
    kind varchar(16) NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'document')),
    storage_path text NOT NULL,
    caption text,
    uploaded_by uuid REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_preparations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reference varchar(24) NOT NULL UNIQUE
        DEFAULT ('PRP-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('vehicle_preparation_reference_seq')::text, 6, '0')),
    vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
    return_id uuid REFERENCES vehicle_returns(id) ON DELETE RESTRICT,
    rental_id uuid REFERENCES rentals(id) ON DELETE RESTRICT,
    reservation_id uuid REFERENCES reservations(id) ON DELETE RESTRICT,
    return_inspection_id uuid REFERENCES return_inspections(id) ON DELETE SET NULL,
    preparation_unavailability_id uuid,
    status varchar(28) NOT NULL DEFAULT 'awaiting_preparation' CHECK (
        status IN (
            'awaiting_preparation',
            'inspection',
            'cleaning',
            'maintenance_if_required',
            'final_quality_check',
            'ready_for_service',
            'blocked',
            'requires_additional_repair',
            'failed_quality_check',
            'cancelled'
        )
    ),
    cleaning_assigned_to uuid REFERENCES users(id),
    cleaning_started_at timestamptz,
    cleaning_completed_at timestamptz,
    cleaning_completed boolean NOT NULL DEFAULT false,
    maintenance_required boolean NOT NULL DEFAULT false,
    maintenance_completed boolean NOT NULL DEFAULT false,
    quality_checked_by uuid REFERENCES users(id),
    quality_checked_at timestamptz,
    quality_approved boolean NOT NULL DEFAULT false,
    quality_notes text,
    operational_ready boolean NOT NULL DEFAULT false,
    ready_at timestamptz,
    reintegrated_at timestamptz,
    reintegrated_by uuid REFERENCES users(id),
    location_id uuid REFERENCES rental_locations(id),
    final_mileage_km integer CHECK (final_mileage_km IS NULL OR final_mileage_km >= 0),
    final_fuel_level_pct smallint CHECK (final_fuel_level_pct IS NULL OR (final_fuel_level_pct >= 0 AND final_fuel_level_pct <= 100)),
    block_reason text,
    request_fingerprint varchar(160),
    superseded_by_id uuid REFERENCES vehicle_preparations(id) ON DELETE SET NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preparation_cleaning_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    preparation_id uuid NOT NULL REFERENCES vehicle_preparations(id) ON DELETE CASCADE,
    task_key varchar(40) NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    required boolean NOT NULL DEFAULT true,
    notes text,
    photos jsonb NOT NULL DEFAULT '[]'::jsonb,
    completed_by uuid REFERENCES users(id),
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_preparation_cleaning_task UNIQUE (preparation_id, task_key)
);

CREATE TABLE IF NOT EXISTS preparation_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    preparation_id uuid NOT NULL REFERENCES vehicle_preparations(id) ON DELETE RESTRICT,
    seq integer NOT NULL,
    event_type varchar(48) NOT NULL,
    from_status varchar(28),
    to_status varchar(28),
    actor_id uuid REFERENCES users(id),
    actor_role varchar(16),
    reason text,
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    server_ts timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_preparation_event_seq UNIQUE (preparation_id, seq)
);

-- Ensure legacy check constraint on preparation_cleaning_tasks allows 'return_cleaning'
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'preparation_cleaning_tasks_task_key_check'
          AND conrelid = 'public.preparation_cleaning_tasks'::regclass
    ) THEN
        ALTER TABLE preparation_cleaning_tasks
            DROP CONSTRAINT preparation_cleaning_tasks_task_key_check;
        ALTER TABLE preparation_cleaning_tasks
            ADD CONSTRAINT preparation_cleaning_tasks_task_key_check CHECK (
                task_key IN (
                    'return_cleaning',
                    'exterior_wash',
                    'interior_cleaning',
                    'seat_upholstery',
                    'dashboard_surfaces',
                    'windows_mirrors',
                    'wheel_cleaning',
                    'odor_verification',
                    'personal_belongings_check',
                    'luxury_presentation'
                )
            );
    END IF;
END $$;

-- Ensure return_evidence.inspection_id references inspections(id) when legacy FK targeted return_inspections(id)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class ref ON ref.oid = c.confrelid
        WHERE c.conname = 'return_evidence_inspection_id_fkey'
          AND c.conrelid = 'public.return_evidence'::regclass
          AND ref.relname = 'return_inspections'
    ) AND NOT EXISTS (
        SELECT 1 FROM return_evidence e
        WHERE e.inspection_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.id = e.inspection_id)
    ) THEN
        ALTER TABLE return_evidence
            DROP CONSTRAINT return_evidence_inspection_id_fkey;
        ALTER TABLE return_evidence
            ADD CONSTRAINT return_evidence_inspection_id_fkey
            FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE;
    END IF;
END $$;

-- 5) Ensure required indexes exist (accept existing compatible indexes)
CREATE UNIQUE INDEX IF NOT EXISTS uq_return_once_per_rental
    ON vehicle_returns(rental_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prep_active_per_vehicle
    ON vehicle_preparations(vehicle_id)
    WHERE status NOT IN ('ready_for_service','cancelled');

CREATE INDEX IF NOT EXISTS idx_returns_status
    ON vehicle_returns(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_return_evidence_return
    ON return_evidence(return_id, created_at);

-- 6) Ensure return_inspections has compatible columns/constraints if missing
ALTER TABLE return_inspections
    ALTER COLUMN mileage_km DROP NOT NULL;

ALTER TABLE return_inspections
    ALTER COLUMN fuel_level_pct DROP NOT NULL;

-- 7) Ensure preparation_cleaning_tasks has unique constraint if needed
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_preparation_cleaning_task'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_cleaning_task'
    ) THEN
        -- Try to add if not exists
        BEGIN
            ALTER TABLE preparation_cleaning_tasks 
                ADD CONSTRAINT uq_preparation_cleaning_task UNIQUE(preparation_id, task_key);
        EXCEPTION
            WHEN duplicate_table OR duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- 8) Ensure preparation_events has unique constraint if needed
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_preparation_event_seq'
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'uq_prep_event_seq'
    ) THEN
        BEGIN
            ALTER TABLE preparation_events 
                ADD CONSTRAINT uq_preparation_event_seq UNIQUE(preparation_id, seq);
        EXCEPTION
            WHEN duplicate_table OR duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- 9) Ensure vehicle_returns has required constraints if compatible
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_agency_return_location') THEN
        BEGIN
            ALTER TABLE vehicle_returns 
                ADD CONSTRAINT chk_agency_return_location CHECK (return_location_id IS NOT NULL OR return_address IS NOT NULL);
        EXCEPTION
            WHEN duplicate_object OR check_violation THEN NULL;
        END;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_return_overdue_minutes') 
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vehicle_returns_overdue_minutes_check') THEN
        BEGIN
            ALTER TABLE vehicle_returns 
                ADD CONSTRAINT chk_return_overdue_minutes CHECK (overdue_minutes IS NULL OR overdue_minutes >= 0);
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;
