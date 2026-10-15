-- A warehouse's own storefront ("house store"): a reseller store run by the
-- warehouse itself, selling its own stock directly. It has no reseller
-- account behind it — the warehouse operates it and is paid for it — so a
-- house store has a warehouse instead of a user.
ALTER TABLE "reseller_stores" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "reseller_stores" ADD COLUMN "house_warehouse_id" UUID;
CREATE UNIQUE INDEX "reseller_stores_house_warehouse_id_key" ON "reseller_stores"("house_warehouse_id");
ALTER TABLE "reseller_stores" ADD CONSTRAINT "reseller_stores_house_warehouse_id_fkey" FOREIGN KEY ("house_warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Exactly one of the two: an independent reseller, or a warehouse's own store.
ALTER TABLE "reseller_stores" ADD CONSTRAINT "reseller_stores_owner_check" CHECK (("user_id" IS NULL) <> ("house_warehouse_id" IS NULL));
