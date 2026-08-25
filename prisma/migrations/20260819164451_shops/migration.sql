-- New role: a Store sells its own stock directly (no warehouse, no approval).
ALTER TYPE "UserRole" ADD VALUE 'STORE';
ALTER TYPE "LedgerAccountType" ADD VALUE 'STORE';

CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "shop_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "parish" TEXT NOT NULL DEFAULT 'Kingston',

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_products" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "price_jmd" DECIMAL(12,2) NOT NULL,
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shops_slug_key" ON "shops"("slug");
CREATE UNIQUE INDEX "shop_products_sku_key" ON "shop_products"("sku");

ALTER TABLE "shops" ADD CONSTRAINT "shops_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shop_products" ADD CONSTRAINT "shop_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add PostGIS location, same pattern as warehouses.location.
ALTER TABLE "shops" ADD COLUMN "location" geometry(Point, 4326) NOT NULL;

-- Orders can now belong to either an affiliate+warehouse pair OR a shop —
-- enforced in the service layer (see src/modules/orders/orders.routes.ts).
ALTER TABLE "orders" ALTER COLUMN "reseller_store_id" DROP NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "warehouse_id" DROP NOT NULL;
ALTER TABLE "orders" ADD COLUMN "shop_id" UUID;
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
