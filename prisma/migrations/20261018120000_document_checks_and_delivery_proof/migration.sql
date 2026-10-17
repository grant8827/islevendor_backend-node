-- Warehouse KYC documents are now read by backend-fastapi at sign-up, and a
-- driver's delivery photo records what it shows and whether it checked out.

ALTER TYPE "DocumentVerificationStatus" ADD VALUE IF NOT EXISTS 'DETAILS_MISMATCH';

CREATE TYPE "ProofOfDeliveryType" AS ENUM ('PACKAGE_WITH_ID', 'PACKAGE_WITH_RECIPIENT');
CREATE TYPE "ProofOfDeliveryCheck" AS ENUM ('PASSED', 'FLAGGED', 'NOT_CHECKED');

ALTER TABLE "warehouses"
  ADD COLUMN "cocj_verification_status" "DocumentVerificationStatus",
  ADD COLUMN "trn_card_verification_status" "DocumentVerificationStatus",
  ADD COLUMN "proof_of_address_verification_status" "DocumentVerificationStatus",
  ADD COLUMN "proof_of_address_issued_on" DATE,
  ADD COLUMN "document_problems" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "orders"
  ADD COLUMN "proof_of_delivery_type" "ProofOfDeliveryType",
  ADD COLUMN "proof_of_delivery_check" "ProofOfDeliveryCheck",
  ADD COLUMN "proof_of_delivery_note" TEXT;
