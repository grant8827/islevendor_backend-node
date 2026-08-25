-- Warehouses can temporarily revoke an approved reseller without deleting
-- the relationship (distinct from REJECTED, which precedes ever approving).
ALTER TYPE "AuthorizationStatus" ADD VALUE 'SUSPENDED';

-- Being APPROVED for a warehouse only grants the relationship — a reseller
-- can only list a specific SKU once the warehouse explicitly grants it.
CREATE TABLE "reseller_product_grants" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "master_product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reseller_product_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reseller_product_grants_store_id_master_product_id_key" ON "reseller_product_grants"("store_id", "master_product_id");

ALTER TABLE "reseller_product_grants" ADD CONSTRAINT "reseller_product_grants_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "reseller_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reseller_product_grants" ADD CONSTRAINT "reseller_product_grants_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
