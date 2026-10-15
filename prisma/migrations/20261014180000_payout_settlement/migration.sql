-- How a payout request was settled: an IsleVendor admin sends the money
-- (bank transfer or Lynk) outside the platform, then records it here as
-- PAID with the transfer reference — or FAILED, which puts the money back
-- in the account's available balance (see ledger.service.ts's settlePayout).
ALTER TABLE "payouts"
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "note" TEXT,
  ADD COLUMN "settled_at" TIMESTAMPTZ,
  ADD COLUMN "settled_by" UUID;
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");
