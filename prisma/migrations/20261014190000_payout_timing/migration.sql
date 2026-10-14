-- How long a withdrawal usually takes to reach someone's bank, in business
-- days — set by an IsleVendor admin, shown before withdrawing, and stamped
-- on each payout as the date it's expected by.
ALTER TABLE "platform_settings"
  ADD COLUMN "payout_min_business_days" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "payout_max_business_days" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "payouts" ADD COLUMN "expected_by" DATE;
