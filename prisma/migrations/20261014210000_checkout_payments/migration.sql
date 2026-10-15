-- Paying for a checkout through WiPay's hosted checkout (see
-- src/modules/payments). One CheckoutPayment covers every order a customer
-- placed together; a retry creates a new one and supersedes the old.
CREATE TYPE "CheckoutPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'SUPERSEDED', 'DUPLICATE');

CREATE TABLE "checkout_payments" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    -- Sent to WiPay as order_id: short (WiPay recommends 16 characters at
    -- most), letters and digits only, unique per attempt.
    "reference" TEXT NOT NULL,
    -- The orders this attempt pays for, fixed when it was created.
    "order_ids" UUID[] NOT NULL,
    -- The total sent to WiPay. WiPay's success hash is checked against it.
    "amount_jmd" DECIMAL(12,2) NOT NULL,
    "status" "CheckoutPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "wipay_transaction_id" TEXT,
    "checkout_url" TEXT,
    "message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ,

    CONSTRAINT "checkout_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checkout_payments_reference_key" ON "checkout_payments"("reference");
CREATE UNIQUE INDEX "checkout_payments_wipay_transaction_id_key" ON "checkout_payments"("wipay_transaction_id");
CREATE INDEX "checkout_payments_customer_id_created_at_idx" ON "checkout_payments"("customer_id", "created_at");
ALTER TABLE "checkout_payments" ADD CONSTRAINT "checkout_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An order points at its current payment attempt.
ALTER TABLE "orders" ADD COLUMN "checkout_payment_id" UUID;
CREATE INDEX "orders_checkout_payment_id_idx" ON "orders"("checkout_payment_id");
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_payment_id_fkey" FOREIGN KEY ("checkout_payment_id") REFERENCES "checkout_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One WiPay transaction now pays several orders, so it's no longer unique per order.
DROP INDEX IF EXISTS "orders_wipay_transaction_id_key";
CREATE INDEX "orders_wipay_transaction_id_idx" ON "orders"("wipay_transaction_id");
