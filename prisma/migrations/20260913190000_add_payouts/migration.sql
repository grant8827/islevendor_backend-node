-- A withdrawal event: sweeps every not-yet-withdrawn, not-refunded ledger
-- leg on one account into a single record (see ledger.service.ts's
-- withdrawBalance). Internal bookkeeping only, same caveat as refunds.
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "ledger_account_id" UUID NOT NULL,
    "amount_jmd" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- Null means this leg is still sitting in the account's balance (shows in
-- the Payout tab); once withdrawn it points at the Payout that swept it
-- (shows in Payout History instead).
ALTER TABLE "ledger_transactions" ADD COLUMN "payout_id" UUID;

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_ledger_account_id_fkey" FOREIGN KEY ("ledger_account_id") REFERENCES "ledger_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
