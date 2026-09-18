-- Driver delivery flow (Delivery/Delivered tabs + proof-of-delivery
-- notification to the seller) needs to know *when* an order was delivered,
-- separate from when it was placed. Purely additive.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "delivered_at" TIMESTAMPTZ;
