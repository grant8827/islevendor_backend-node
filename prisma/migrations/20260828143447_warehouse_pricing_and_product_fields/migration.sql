-- Warehouse: what % of its (post-discount) wholesale price a reseller earns.
ALTER TABLE "warehouses" ADD COLUMN "reseller_commission_percent" INTEGER NOT NULL DEFAULT 20;

-- MasterProduct: warehouse's own B2B discount, condition, and free-text
-- customer-facing details (return policy, warranty, etc.).
CREATE TYPE "ProductCondition" AS ENUM ('NEW', 'USED');

ALTER TABLE "master_products" ADD COLUMN "discount_percent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "master_products" ADD COLUMN "condition" "ProductCondition" NOT NULL DEFAULT 'NEW';
ALTER TABLE "master_products" ADD COLUMN "product_details" TEXT;
