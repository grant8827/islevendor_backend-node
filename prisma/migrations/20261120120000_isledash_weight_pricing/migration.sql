-- IsleDash weight pricing (Admin → Settings → Shipping). Everything one
-- seller sends in a delivery is weighed together; each pound over the
-- included weight adds the per-pound price to the IsleDash fee. Per pound
-- starts at 0, so nothing changes for customers until an admin sets it.
ALTER TABLE "platform_settings"
  ADD COLUMN "isledash_included_weight_lb" DECIMAL(7, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN "isledash_per_pound_jmd"      DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "isledash_max_weight_lb"      DECIMAL(7, 2);

-- A product's shipping weight in pounds, per unit. Null: not entered yet,
-- counted as 0 lb.
ALTER TABLE "master_products" ADD COLUMN "weight_lb" DECIMAL(7, 2);
ALTER TABLE "shop_products"   ADD COLUMN "weight_lb" DECIMAL(7, 2);

-- The total weight an IsleDash order was priced for.
ALTER TABLE "orders" ADD COLUMN "delivery_weight_lb" DECIMAL(9, 2);
