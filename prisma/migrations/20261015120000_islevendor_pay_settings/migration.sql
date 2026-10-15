-- IsleVendor Pay (the Superadmin's payment section): settings an admin can
-- change without a deploy. Each sits *under* its deploy-level switch in the
-- environment — an admin can pause card payments or automated payouts at
-- once, but can't turn on something the deployment has switched off.
ALTER TABLE "platform_settings"
  ADD COLUMN "payments_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "automated_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
  -- Who pays WiPay's card fee; null means WIPAY_FEE_STRUCTURE from the environment.
  ADD COLUMN "wipay_fee_structure" TEXT,
  -- IsleVendor's commission on every item sold, as a percent of the
  -- seller's price. Orders keep the amount they were charged, so a change
  -- applies to new orders only.
  ADD COLUMN "platform_commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 5;

-- A payment that has to be given back (e.g. a DUPLICATE) is marked REFUNDED
-- once an admin has refunded it in WiPay, with WiPay's reference.
ALTER TYPE "CheckoutPaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TABLE "checkout_payments"
  ADD COLUMN "refund_reference" TEXT,
  ADD COLUMN "refunded_at" TIMESTAMPTZ,
  ADD COLUMN "refunded_by" UUID;
