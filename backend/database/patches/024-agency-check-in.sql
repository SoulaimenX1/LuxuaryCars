-- Agency check-in records collection without inventing fuel or condition data.
ALTER TABLE inspections
    ALTER COLUMN fuel_level_pct DROP NOT NULL,
    ALTER COLUMN overall_condition DROP NOT NULL;
