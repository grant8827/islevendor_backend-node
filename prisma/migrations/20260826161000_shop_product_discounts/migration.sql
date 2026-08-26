ALTER TABLE "shop_products"
ADD COLUMN "discount_percent" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "shop_products"
ADD CONSTRAINT "shop_products_discount_percent_check"
CHECK ("discount_percent" >= 0 AND "discount_percent" <= 90);
