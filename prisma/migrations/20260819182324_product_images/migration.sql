-- Gallery images for master products (warehouse) and shop products (store).
-- imageUrl stays as the "main" photo (images[0]) so every existing read path
-- keeps working unchanged; images[] additionally holds the full gallery for
-- the new product detail page.
ALTER TABLE "master_products" ADD COLUMN "images" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "shop_products" ADD COLUMN "images" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: any product that already has a main image but no gallery gets a
-- one-element gallery containing that image, so existing products render
-- correctly in the new gallery UI without needing to be re-saved.
UPDATE "master_products" SET "images" = ARRAY["image_url"] WHERE "image_url" IS NOT NULL AND array_length("images", 1) IS NULL;
UPDATE "shop_products" SET "images" = ARRAY["image_url"] WHERE "image_url" IS NOT NULL AND array_length("images", 1) IS NULL;
