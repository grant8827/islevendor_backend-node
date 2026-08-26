CREATE TABLE "delivery_applications" (
    "id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "warehouse_id" UUID,
    "shop_id" UUID,
    "status" "AuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "delivery_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_applications_driver_id_warehouse_id_key"
ON "delivery_applications"("driver_id", "warehouse_id");

CREATE UNIQUE INDEX "delivery_applications_driver_id_shop_id_key"
ON "delivery_applications"("driver_id", "shop_id");

ALTER TABLE "delivery_applications"
ADD CONSTRAINT "delivery_applications_driver_id_fkey"
FOREIGN KEY ("driver_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_applications"
ADD CONSTRAINT "delivery_applications_warehouse_id_fkey"
FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "delivery_applications"
ADD CONSTRAINT "delivery_applications_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
