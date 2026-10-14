-- Multi-item shipping: when a customer buys several items from one seller in
-- one checkout, the first item is charged the full delivery fee and every
-- further item a percentage of it (see src/lib/deliveryOptions.ts).

-- Each warehouse/shop sets the rule for its own delivery.
ALTER TABLE "warehouses" ADD COLUMN "seller_delivery_extra_item_percent" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "shops" ADD COLUMN "seller_delivery_extra_item_percent" INTEGER NOT NULL DEFAULT 50;

-- IsleVendor sets the rule for IsleDash delivery, in the admin console.
-- One row, id 'default'; the code falls back to the same values if it's
-- missing.
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL,
    "isledash_base_fee_jmd" DECIMAL(12,2) NOT NULL DEFAULT 300,
    "isledash_extra_item_percent" INTEGER NOT NULL DEFAULT 50,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "platform_settings" ("id") VALUES ('default');

-- Orders placed together from one seller share their shipping charge; this
-- ties them together.
ALTER TABLE "orders" ADD COLUMN "checkout_group_id" UUID;
CREATE INDEX "orders_checkout_group_id_idx" ON "orders"("checkout_group_id");
