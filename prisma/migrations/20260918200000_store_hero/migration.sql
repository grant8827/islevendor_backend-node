-- A reseller's own choice of banner for their storefront / My Store tab:
-- the platform default gradient, a solid color, or an uploaded image.
CREATE TYPE "StoreHeroMode" AS ENUM ('DEFAULT', 'COLOR', 'IMAGE');

ALTER TABLE "reseller_stores" ADD COLUMN "hero_mode" "StoreHeroMode" NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE "reseller_stores" ADD COLUMN "hero_color" TEXT;
ALTER TABLE "reseller_stores" ADD COLUMN "hero_image_url" TEXT;
