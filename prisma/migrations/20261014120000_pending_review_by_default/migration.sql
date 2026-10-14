-- Every new warehouse, reseller store and shop now starts out awaiting
-- IsleVendor's approval, however it was created. The onboarding forms
-- already set PENDING_REVIEW explicitly; this closes the dashboards' quick
-- "add a warehouse/store" forms, which relied on the old APPROVED default
-- and so skipped review entirely. Existing rows keep their current status.
ALTER TABLE "warehouses" ALTER COLUMN "applicant_status" SET DEFAULT 'PENDING_REVIEW';
ALTER TABLE "reseller_stores" ALTER COLUMN "applicant_status" SET DEFAULT 'PENDING_REVIEW';
ALTER TABLE "shops" ALTER COLUMN "applicant_status" SET DEFAULT 'PENDING_REVIEW';
