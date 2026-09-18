-- Distinct from CANCELLED: money was actually collected and credited out
-- (ledger legs exist) before this order was reversed — see Refund below.
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED';

-- Marks a ledger leg as unwound by a refund (see ledger.service.ts's
-- refundOrder). The row is kept, not deleted, so payout history still shows
-- the original credit, just annotated as reversed. Null means still in effect.
ALTER TABLE "ledger_transactions" ADD COLUMN "reversed_at" TIMESTAMPTZ;

-- Internal bookkeeping only — no live payment-processor call exists yet
-- (WiPay checkout itself isn't wired up). Issuing one reverses this order's
-- ledger legs and flips its status to REFUNDED.
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_jmd" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "initiated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refunds_order_id_key" ON "refunds"("order_id");

ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_fkey" FOREIGN KEY ("initiated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
