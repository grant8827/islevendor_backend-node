-- ISLE-101..105: onboarding/KYC fields for Warehouse, ResellerStore, Shop,
-- and DriverProfile, plus the shared ApplicantStatus enum. Purely additive
-- (new nullable columns / new enum types / new unique indexes on nullable
-- columns) — existing rows and existing routes are unaffected.
--
-- NOTE: `prisma migrate diff` against the live dev DB also proposed dropping
-- and recreating the orders_* foreign keys and two unrelated indexes on
-- orders/product_ratings. That's pre-existing drift unrelated to this change
-- (not something this migration touches) — deliberately left out here so
-- this migration stays scoped to ISLE-100's onboarding fields only.

-- CreateEnum
CREATE TYPE "ApplicantStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DriverVehicleType" AS ENUM ('MOTORCYCLE', 'SEDAN', 'CARGO_VAN', 'BOX_TRUCK');

-- CreateEnum
CREATE TYPE "DriverAvailability" AS ENUM ('FULL_TIME', 'PART_TIME', 'WEEKEND');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'LYNK_WALLET');

-- CreateEnum
CREATE TYPE "ResellerType" AS ENUM ('INDIVIDUAL_CREATOR', 'REGISTERED_BUSINESS');

-- CreateEnum
CREATE TYPE "SalesChannel" AS ENUM ('SOCIAL', 'WHATSAPP', 'WEBSITE', 'POP_UP');

-- CreateEnum
CREATE TYPE "VendorCategory" AS ENUM ('ARTISAN', 'COTTAGE_FOOD', 'RETAIL_BOUTIQUE', 'AGRI_PROCESSOR');

-- CreateEnum
CREATE TYPE "FulfillmentStrategy" AS ENUM ('SELF_DISPATCH', 'HUB_CONSIGNMENT', 'HYBRID');

-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "account_holder_name" TEXT,
ADD COLUMN     "account_number" TEXT,
ADD COLUMN     "applicant_status" "ApplicantStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
ADD COLUMN     "availability" "DriverAvailability",
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "branch_code" TEXT,
ADD COLUMN     "fitness_cert_url" TEXT,
ADD COLUMN     "has_cold_box" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "home_parish" TEXT,
ADD COLUMN     "home_town" TEXT,
ADD COLUMN     "insurance_cert_url" TEXT,
ADD COLUMN     "license_plate" TEXT,
ADD COLUMN     "lynk_wallet_id" TEXT,
ADD COLUMN     "payout_method" "PayoutMethod",
ADD COLUMN     "reference_id" TEXT,
ADD COLUMN     "sla_accepted_at" TIMESTAMPTZ,
ADD COLUMN     "trn" TEXT,
ADD COLUMN     "vehicle_make" TEXT,
ADD COLUMN     "vehicle_model" TEXT,
ADD COLUMN     "vehicle_type" "DriverVehicleType",
ADD COLUMN     "vehicle_year" INTEGER,
ADD COLUMN     "whatsapp_number" TEXT,
ADD COLUMN     "zone_parishes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "license_number" DROP NOT NULL,
ALTER COLUMN "license_expiry" DROP NOT NULL,
ALTER COLUMN "license_image_url" DROP NOT NULL,
ALTER COLUMN "selfie_image_url" DROP NOT NULL;

-- AlterTable
ALTER TABLE "reseller_stores" ADD COLUMN     "account_holder_name" TEXT,
ADD COLUMN     "account_number" TEXT,
ADD COLUMN     "applicant_status" "ApplicantStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "branch_code" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "default_markup_percent" DECIMAL(5,2),
ADD COLUMN     "id_doc_url" TEXT,
ADD COLUMN     "instagram_handle" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "lynk_wallet_id" TEXT,
ADD COLUMN     "parish" TEXT,
ADD COLUMN     "payout_method" "PayoutMethod",
ADD COLUMN     "primary_sales_channel" "SalesChannel",
ADD COLUMN     "reference_id" TEXT,
ADD COLUMN     "reseller_type" "ResellerType",
ADD COLUMN     "sla_accepted_at" TIMESTAMPTZ,
ADD COLUMN     "target_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "tiktok_handle" TEXT,
ADD COLUMN     "trn" TEXT;

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "account_holder_name" TEXT,
ADD COLUMN     "account_number" TEXT,
ADD COLUMN     "applicant_status" "ApplicantStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "branch_code" TEXT,
ADD COLUMN     "estimated_item_count" INTEGER,
ADD COLUMN     "fulfillment_strategy" "FulfillmentStrategy",
ADD COLUMN     "gov_id_doc_url" TEXT,
ADD COLUMN     "lynk_wallet_id" TEXT,
ADD COLUMN     "owner_name" TEXT,
ADD COLUMN     "payout_method" "PayoutMethod",
ADD COLUMN     "pickup_address" TEXT,
ADD COLUMN     "reference_id" TEXT,
ADD COLUMN     "sla_accepted_at" TIMESTAMPTZ,
ADD COLUMN     "trn" TEXT,
ADD COLUMN     "vendor_category" "VendorCategory",
ADD COLUMN     "whatsapp_number" TEXT;

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "account_holder_name" TEXT,
ADD COLUMN     "account_number" TEXT,
ADD COLUMN     "applicant_status" "ApplicantStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "branch_code" TEXT,
ADD COLUMN     "cocj_doc_url" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "coverage_parishes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "gct_number" TEXT,
ADD COLUMN     "legal_business_name" TEXT,
ADD COLUMN     "loading_bay_count" INTEGER,
ADD COLUMN     "lynk_wallet_id" TEXT,
ADD COLUMN     "operating_hours" TEXT,
ADD COLUMN     "payout_method" "PayoutMethod",
ADD COLUMN     "proof_of_address_url" TEXT,
ADD COLUMN     "reference_id" TEXT,
ADD COLUMN     "security_controls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sla_accepted_at" TIMESTAMPTZ,
ADD COLUMN     "storage_sq_ft" INTEGER,
ADD COLUMN     "storage_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "town" TEXT,
ADD COLUMN     "trn" TEXT,
ADD COLUMN     "trn_card_url" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_reference_id_key" ON "driver_profiles"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_stores_reference_id_key" ON "reseller_stores"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_reference_id_key" ON "shops"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_reference_id_key" ON "warehouses"("reference_id");
