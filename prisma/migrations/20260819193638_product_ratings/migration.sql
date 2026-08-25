-- Orders now record exactly which item (and how many) was bought — needed
-- to prove a customer actually received a specific product before letting
-- them rate it. Existing orders predate this and simply get NULL/1, which
-- means they're not rateable (no proof of which item they were for).
ALTER TABLE "orders" ADD COLUMN "store_listing_id" UUID;
ALTER TABLE "orders" ADD COLUMN "shop_product_id" UUID;
ALTER TABLE "orders" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "orders" ADD CONSTRAINT "orders_store_listing_id_fkey"
  FOREIGN KEY ("store_listing_id") REFERENCES "store_listings"("id") ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_product_id_fkey"
  FOREIGN KEY ("shop_product_id") REFERENCES "shop_products"("id") ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX "orders_store_listing_id_idx" ON "orders"("store_listing_id");
CREATE INDEX "orders_shop_product_id_idx" ON "orders"("shop_product_id");

-- One rating per qualifying (DELIVERED) order — see ratings.routes.ts for
-- the eligibility check. order_id UNIQUE both enforces "one rating per
-- purchase" and gives Order a clean 1:1 `rating` relation.
CREATE TABLE "product_ratings" (
  "id" UUID NOT NULL PRIMARY KEY,
  "customer_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "store_listing_id" UUID,
  "shop_product_id" UUID,
  "rating" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_ratings_rating_range" CHECK ("rating" BETWEEN 1 AND 5)
);

ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_order_id_key" UNIQUE ("order_id");
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_store_listing_id_fkey"
  FOREIGN KEY ("store_listing_id") REFERENCES "store_listings"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_shop_product_id_fkey"
  FOREIGN KEY ("shop_product_id") REFERENCES "shop_products"("id") ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX "product_ratings_store_listing_id_idx" ON "product_ratings"("store_listing_id");
CREATE INDEX "product_ratings_shop_product_id_idx" ON "product_ratings"("shop_product_id");
