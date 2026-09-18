-- Driver onboarding's 3rd verification document is a vehicle certificate of
-- registration, not a certificate of fitness — rename the column to match.
-- A plain RENAME COLUMN preserves any URLs already stored under the old name.

ALTER TABLE "driver_profiles" RENAME COLUMN "fitness_cert_url" TO "registration_cert_url";
