-- Customers' saved delivery address, and a map pin on each order.
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "town" TEXT NOT NULL,
    "parish" TEXT NOT NULL,
    "landmark" TEXT,
    "delivery_instructions" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id"),
    -- A pin is both coordinates or neither.
    CONSTRAINT "customer_addresses_pin_check" CHECK (("latitude" IS NULL) = ("longitude" IS NULL))
);

CREATE UNIQUE INDEX "customer_addresses_user_id_key" ON "customer_addresses"("user_id");

ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "orders"
    ADD COLUMN "delivery_latitude" DECIMAL(9,6),
    ADD COLUMN "delivery_longitude" DECIMAL(9,6);
