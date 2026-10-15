-- How an order gets to the customer, chosen at checkout from the options
-- the selling business offers (see src/lib/deliveryOptions.ts):
--   ISLEDASH         an IsleDash driver; the platform's driver fee
--   SELLER_DELIVERY  the business's own delivery, at the fee it sets
--   PICKUP           the customer collects it; free
CREATE TYPE "DeliveryMethod" AS ENUM ('ISLEDASH', 'SELLER_DELIVERY', 'PICKUP');

-- What each pickup point offers. A reseller's orders ship from the
-- warehouse, so warehouses and shops carry these; resellers don't.
-- Everything existing keeps working exactly as before: IsleDash only.
ALTER TABLE "warehouses"
  ADD COLUMN "offers_isledash" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "offers_seller_delivery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "seller_delivery_fee_jmd" DECIMAL(12,2),
  ADD COLUMN "seller_delivery_note" TEXT,
  ADD COLUMN "offers_pickup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pickup_instructions" TEXT;
ALTER TABLE "shops"
  ADD COLUMN "offers_isledash" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "offers_seller_delivery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "seller_delivery_fee_jmd" DECIMAL(12,2),
  ADD COLUMN "seller_delivery_note" TEXT,
  ADD COLUMN "offers_pickup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pickup_instructions" TEXT;

-- Existing orders were all IsleDash deliveries.
ALTER TABLE "orders"
  ADD COLUMN "delivery_method" "DeliveryMethod" NOT NULL DEFAULT 'ISLEDASH',
  ADD COLUMN "seller_delivery_fee_jmd" DECIMAL(12,2) NOT NULL DEFAULT 0;
