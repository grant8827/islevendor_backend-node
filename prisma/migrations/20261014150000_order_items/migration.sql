-- An order can now hold several items: everything a customer buys from one
-- business in one checkout ships together as one order (one label, one
-- driver trip). The items live here; the order keeps the money totals the
-- ledger splits (see ledger.service.ts) and its own status and delivery.
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "store_listing_id" UUID,
    "shop_product_id" UUID,
    -- What it was called and looked like when bought, so the order still
    -- reads correctly after the product is renamed or removed.
    "title" TEXT NOT NULL,
    "image_url" TEXT,
    "quantity" INTEGER NOT NULL,
    -- This item's share of the order's money, before delivery.
    "goods_total_jmd" DECIMAL(12,2) NOT NULL,
    "wholesale_total_jmd" DECIMAL(12,2) NOT NULL,
    "reseller_margin_jmd" DECIMAL(12,2) NOT NULL,
    "platform_commission_jmd" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_store_listing_id_fkey" FOREIGN KEY ("store_listing_id") REFERENCES "store_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_shop_product_id_fkey" FOREIGN KEY ("shop_product_id") REFERENCES "shop_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every existing order was a single item: copy it across.
INSERT INTO "order_items" (
    "id", "order_id", "store_listing_id", "shop_product_id", "title", "image_url", "quantity",
    "goods_total_jmd", "wholesale_total_jmd", "reseller_margin_jmd", "platform_commission_jmd", "created_at"
)
SELECT
    gen_random_uuid(), o."id", o."store_listing_id", o."shop_product_id",
    COALESCE(mp."title", sp."title", 'Item'), COALESCE(mp."image_url", sp."image_url"), o."quantity",
    o."total_paid_jmd" - o."driver_fee_jmd" - o."seller_delivery_fee_jmd",
    o."wholesale_total_jmd", o."reseller_margin_jmd", o."platform_commission_jmd", o."created_at"
FROM "orders" o
LEFT JOIN "store_listings" sl ON sl."id" = o."store_listing_id"
LEFT JOIN "master_products" mp ON mp."id" = sl."master_product_id"
LEFT JOIN "shop_products" sp ON sp."id" = o."shop_product_id";

-- A rating is now for one item in an order, not the whole order.
ALTER TABLE "product_ratings" DROP CONSTRAINT "product_ratings_order_id_key";
CREATE UNIQUE INDEX "product_ratings_order_id_store_listing_id_key" ON "product_ratings"("order_id", "store_listing_id");
CREATE UNIQUE INDEX "product_ratings_order_id_shop_product_id_key" ON "product_ratings"("order_id", "shop_product_id");
