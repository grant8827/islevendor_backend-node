-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('WAREHOUSE', 'RESELLER', 'DRIVER', 'CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('AWAITING_PAYMENT', 'PACKING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('WAREHOUSE', 'RESELLER', 'DRIVER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD_IN_ESCROW', 'DISBURSED_TO_BANK');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "license_number" TEXT NOT NULL,
    "license_expiry" DATE NOT NULL,
    "license_image_url" TEXT NOT NULL,
    "selfie_image_url" TEXT NOT NULL,
    "facial_match_score" DECIMAL(5,2),
    "is_kyc_approved" BOOLEAN NOT NULL DEFAULT false,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "parish" TEXT NOT NULL DEFAULT 'Kingston',

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_products" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "wholesale_price_jmd" DECIMAL(12,2) NOT NULL,
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reseller_stores" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "store_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "reseller_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_listings" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "master_product_id" UUID NOT NULL,
    "retail_price_jmd" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "store_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "reseller_store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "driver_id" UUID,
    "total_paid_jmd" DECIMAL(12,2) NOT NULL,
    "wholesale_total_jmd" DECIMAL(12,2) NOT NULL,
    "reseller_margin_jmd" DECIMAL(12,2) NOT NULL,
    "driver_fee_jmd" DECIMAL(12,2) NOT NULL,
    "platform_commission_jmd" DECIMAL(12,2) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "delivery_address" TEXT NOT NULL,
    "proof_of_delivery_image_url" TEXT,
    "wipay_transaction_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "account_type" "LedgerAccountType" NOT NULL,
    "bank_name" TEXT,
    "account_number" TEXT,
    "pending_balance_jmd" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    "available_balance_jmd" DECIMAL(12,2) NOT NULL DEFAULT 0.00,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "recipient_account_id" UUID NOT NULL,
    "amount_jmd" DECIMAL(12,2) NOT NULL,
    "escrow_state" "EscrowStatus" NOT NULL DEFAULT 'HELD_IN_ESCROW',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_user_id_key" ON "driver_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "master_products_sku_key" ON "master_products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_stores_user_id_key" ON "reseller_stores"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "reseller_stores_slug_key" ON "reseller_stores"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "orders_wipay_transaction_id_key" ON "orders"("wipay_transaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_order_id_recipient_account_id_key" ON "ledger_transactions"("order_id", "recipient_account_id");

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reseller_stores" ADD CONSTRAINT "reseller_stores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "reseller_stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_listings" ADD CONSTRAINT "store_listings_master_product_id_fkey" FOREIGN KEY ("master_product_id") REFERENCES "master_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_reseller_store_id_fkey" FOREIGN KEY ("reseller_store_id") REFERENCES "reseller_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_recipient_account_id_fkey" FOREIGN KEY ("recipient_account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
