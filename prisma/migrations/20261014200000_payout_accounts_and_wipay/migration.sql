-- Where each person's money goes, and paying it automatically through
-- WiPay's withdrawal API (see src/lib/wipayPayouts.ts and
-- WIPAY_AUTOMATED_PAYOUT_IMPLEMENTATION.md).

-- New payout steps. APPROVED: an admin has checked the request. SUBMITTED:
-- sent to WiPay, outcome not yet confirmed.
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'APPROVED' AFTER 'REQUESTED';
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED' AFTER 'APPROVED';

CREATE TYPE "PayoutChannel" AS ENUM ('MANUAL', 'WIPAY');
CREATE TYPE "BankAccountType" AS ENUM ('CHEQUING', 'SAVINGS');
CREATE TYPE "IdDocumentType" AS ENUM ('DRIVER_PERMIT', 'NATIONAL_ID', 'PASSPORT');

-- One per person: their bank (or Lynk) details for payouts. Account and ID
-- numbers are encrypted by the application (AES-256-GCM, PAYOUT_DATA_KEY);
-- only the last four digits are stored readable.
CREATE TABLE "payout_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method" "PayoutMethod" NOT NULL,
    "bank_name" TEXT,
    "bank_branch" TEXT,
    "bank_account_type" "BankAccountType",
    "account_number_encrypted" TEXT,
    "account_number_last4" TEXT,
    "name_in_bank" TEXT,
    "lynk_wallet_id" TEXT,
    "id_type" "IdDocumentType",
    "id_number_encrypted" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payout_accounts_user_id_key" ON "payout_accounts"("user_id");
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payouts"
  ADD COLUMN "channel" "PayoutChannel",
  ADD COLUMN "approved_at" TIMESTAMPTZ,
  ADD COLUMN "approved_by" UUID,
  -- Where it was sent, as it was at approval — masked, never the full number.
  ADD COLUMN "destination_snapshot" JSONB,
  -- Our own reference for a WiPay submission, sent in its pass-through data.
  -- It's how an uncertain submission is found again before any retry.
  ADD COLUMN "submission_key" UUID,
  ADD COLUMN "submitted_at" TIMESTAMPTZ,
  ADD COLUMN "provider_transaction_id" TEXT,
  ADD COLUMN "provider_reference" TEXT,
  ADD COLUMN "provider_status" INTEGER,
  ADD COLUMN "provider_status_description" TEXT,
  ADD COLUMN "provider_fee_jmd" DECIMAL(12,2),
  ADD COLUMN "provider_checked_at" TIMESTAMPTZ,
  ADD COLUMN "last_error" TEXT;
CREATE UNIQUE INDEX "payouts_submission_key_key" ON "payouts"("submission_key");
CREATE UNIQUE INDEX "payouts_provider_transaction_id_key" ON "payouts"("provider_transaction_id");

-- Every WiPay withdrawal notification received, by WiPay's event id, so a
-- redelivered event is recognised and skipped.
CREATE TABLE "payout_webhook_events" (
    "id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payout_id" UUID,
    "outcome" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payout_webhook_events_provider_event_id_key" ON "payout_webhook_events"("provider_event_id");
