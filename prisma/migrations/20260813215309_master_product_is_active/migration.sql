-- Warehouses can suspend a SKU without deleting it (keeps reseller listings
-- and order history intact, just hides it from the marketplace).
ALTER TABLE "master_products" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
