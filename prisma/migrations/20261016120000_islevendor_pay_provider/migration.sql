-- Which service took each checkout payment. Existing rows are Node's.
CREATE TYPE "PaymentProvider" AS ENUM ('NODE', 'ISLEVENDOR_PAY');

ALTER TABLE "checkout_payments"
    ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'NODE',
    ADD COLUMN "pay_intent_id" UUID;

CREATE UNIQUE INDEX "checkout_payments_pay_intent_id_key" ON "checkout_payments"("pay_intent_id");
