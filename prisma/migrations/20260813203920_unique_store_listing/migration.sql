-- A reseller "adds" a master product to their store at most once.
CREATE UNIQUE INDEX "store_listings_store_id_master_product_id_key" ON "store_listings"("store_id", "master_product_id");
