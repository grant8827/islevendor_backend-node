-- Driver KYC document OCR verification (license/insurance/registration name
-- match + expiry) — see src/lib/ocrClient.ts and
-- src/modules/onboarding/onboarding.routes.ts. Purely additive (new nullable
-- columns, new enum) — existing rows are unaffected.

-- CreateEnum
CREATE TYPE "DocumentVerificationStatus" AS ENUM ('VERIFIED', 'NAME_MISMATCH', 'EXPIRED', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "driver_profiles"
  ADD COLUMN     "license_holder_name" TEXT,
  ADD COLUMN     "license_verification_status" "DocumentVerificationStatus",
  ADD COLUMN     "insurance_cert_expiry" DATE,
  ADD COLUMN     "insurance_holder_name" TEXT,
  ADD COLUMN     "insurance_verification_status" "DocumentVerificationStatus",
  ADD COLUMN     "registration_cert_expiry" DATE,
  ADD COLUMN     "registration_holder_name" TEXT,
  ADD COLUMN     "registration_verification_status" "DocumentVerificationStatus";
