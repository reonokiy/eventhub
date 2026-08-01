UPDATE tenants
SET retention_days = 30,
    updated_at = clock_timestamp()
WHERE retention_days < 30;

ALTER TABLE tenants
  DROP CONSTRAINT tenants_retention_days_positive;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_retention_days_minimum
  CHECK (retention_days >= 30);
