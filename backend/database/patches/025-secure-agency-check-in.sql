CREATE TABLE reservation_checkin_credentials (
    reservation_id uuid PRIMARY KEY REFERENCES reservations(id) ON DELETE RESTRICT,
    customer_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    agency_id uuid NOT NULL REFERENCES rental_locations(id) ON DELETE RESTRICT,
    code_hash char(64) NOT NULL,
    expires_at timestamptz NOT NULL,
    failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
    first_viewed_at timestamptz,
    last_rotated_at timestamptz,
    consumed_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_checkin_credentials_customer
    ON reservation_checkin_credentials(customer_id, expires_at);

CREATE TABLE agency_staff_assignments (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    agency_id uuid NOT NULL REFERENCES rental_locations(id) ON DELETE RESTRICT,
    assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, agency_id)
);

ALTER TABLE inspections
    ALTER COLUMN mileage_km DROP NOT NULL;

CREATE TABLE inspection_photos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE RESTRICT,
    photo_path text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inspection_photos_inspection
    ON inspection_photos(inspection_id, created_at);
