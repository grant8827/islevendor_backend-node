-- CreateEnum
CREATE TYPE "AuthorizationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "reseller_authorizations" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "reseller_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reseller_authorizations_store_id_warehouse_id_key" ON "reseller_authorizations"("store_id", "warehouse_id");

-- AddForeignKey
ALTER TABLE "reseller_authorizations" ADD CONSTRAINT "reseller_authorizations_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "reseller_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_authorizations" ADD CONSTRAINT "reseller_authorizations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
