-- Warehouse staff: extra logins (per-warehouse ADMIN or STAFF) for a
-- warehouse owner's dashboard. See WarehouseMember in schema.prisma.
CREATE TYPE "WarehouseMemberRole" AS ENUM ('ADMIN', 'STAFF');

-- The owner whose business a dashboard-created staff account works for.
-- Null for every self-registered account.
ALTER TABLE "users" ADD COLUMN "staff_of_user_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_staff_of_user_id_fkey" FOREIGN KEY ("staff_of_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "warehouse_members" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "WarehouseMemberRole" NOT NULL DEFAULT 'STAFF',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_members_warehouse_id_user_id_key" ON "warehouse_members"("warehouse_id", "user_id");
CREATE INDEX "warehouse_members_user_id_idx" ON "warehouse_members"("user_id");

ALTER TABLE "warehouse_members" ADD CONSTRAINT "warehouse_members_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_members" ADD CONSTRAINT "warehouse_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
