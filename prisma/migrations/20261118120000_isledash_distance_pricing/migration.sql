-- IsleDash delivery priced by distance (Admin → Settings → Shipping).
-- The fee is base + price per mile beyond the included miles, measured
-- from the seller's map pin to the buyer's. Price per mile starts at 0 and
-- the fallback starts at today's base fee, so nothing changes for
-- customers until an admin sets distance pricing.
ALTER TABLE "platform_settings"
  ADD COLUMN "isledash_included_miles"          DECIMAL(6, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN "isledash_per_mile_jmd"            DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "isledash_min_fee_jmd"             DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "isledash_max_fee_jmd"             DECIMAL(12, 2),
  ADD COLUMN "isledash_max_miles"               DECIMAL(6, 2),
  ADD COLUMN "isledash_fallback_fee_jmd"        DECIMAL(12, 2) NOT NULL DEFAULT 300,
  ADD COLUMN "isledash_road_adjust_percent"     INTEGER        NOT NULL DEFAULT 30;

UPDATE "platform_settings" SET "isledash_fallback_fee_jmd" = "isledash_base_fee_jmd";

-- A seller's exact map pin, placed from its dashboard. `location` (PostGIS,
-- used for driver dispatch) is only a parish centre until one is placed;
-- placing a pin updates both. Null: not pinned, so IsleDash charges the
-- fallback fee.
ALTER TABLE "shops"
  ADD COLUMN "pin_latitude"  DECIMAL(9, 6),
  ADD COLUMN "pin_longitude" DECIMAL(9, 6);
ALTER TABLE "warehouses"
  ADD COLUMN "pin_latitude"  DECIMAL(9, 6),
  ADD COLUMN "pin_longitude" DECIMAL(9, 6);

-- How far an IsleDash order was priced for, in road miles (straight line
-- plus the road adjustment). Null: priced at the fallback fee, or not IsleDash.
ALTER TABLE "orders" ADD COLUMN "delivery_distance_miles" DECIMAL(7, 2);
