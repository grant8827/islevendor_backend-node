-- Ledger integrity: honest state names, a record of every payment-provider
-- callback, and database-level guards against a negative balance.

-- A leg in this state has been released from escrow into the recipient's
-- available balance on delivery. Nothing has been sent to a bank at that
-- point, so the old name claimed more than had happened.
ALTER TYPE "EscrowStatus" RENAME VALUE 'DISBURSED_TO_BANK' TO 'AVAILABLE';

-- A Payout row used to be created the moment a seller pressed Withdraw, with
-- no status at all — indistinguishable from money actually sent. Every
-- existing row is exactly that kind of bookkeeping-only request, hence the
-- REQUESTED default; PAID is only for a verified external settlement.
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REVERSED');
ALTER TABLE "payouts" ADD COLUMN "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED';

-- One row per callback received from a payment provider. The unique
-- (provider, provider_event_id) key is what makes a redelivered or replayed
-- callback a no-op (see ledger.service.ts's processWiPayWebhook).
CREATE TYPE "PaymentEventOutcome" AS ENUM ('RECEIVED', 'APPLIED', 'IGNORED_NOT_SUCCESS', 'IGNORED_ORDER_NOT_AWAITING_PAYMENT');
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" "PaymentEventOutcome" NOT NULL DEFAULT 'RECEIVED',
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key" ON "payment_events"("provider", "provider_event_id");
CREATE INDEX "payment_events_order_id_idx" ON "payment_events"("order_id");
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Last line of defence: no code path may drive a balance below zero. NOT
-- VALID so this can't fail on (or lock a scan over) existing rows — it still
-- applies to every insert and update from here on. Run VALIDATE CONSTRAINT
-- once existing balances have been reconciled.
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_pending_balance_non_negative" CHECK ("pending_balance_jmd" >= 0) NOT VALID;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_available_balance_non_negative" CHECK ("available_balance_jmd" >= 0) NOT VALID;
