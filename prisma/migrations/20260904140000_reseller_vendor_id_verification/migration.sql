-- Extends OCR document verification (name-on-file match + expiry) from
-- driver_profiles to the reseller and small-vendor onboarding flows' own
-- personal photo ID uploads. Purely additive (new nullable columns, reusing
-- the existing DocumentVerificationStatus enum) — existing rows unaffected.

-- AlterTable
ALTER TABLE "reseller_stores"
  ADD COLUMN     "id_doc_expiry" DATE,
  ADD COLUMN     "id_doc_holder_name" TEXT,
  ADD COLUMN     "id_doc_verification_status" "DocumentVerificationStatus";

-- AlterTable
ALTER TABLE "shops"
  ADD COLUMN     "gov_id_expiry" DATE,
  ADD COLUMN     "gov_id_holder_name" TEXT,
  ADD COLUMN     "gov_id_verification_status" "DocumentVerificationStatus";
