-- Home page hero cards: items an admin picks from what's listed on the site
-- (Admin Console → Home Hero). listing_id is a store_listings or
-- shop_products id, so it has no foreign key.
CREATE TABLE "hero_slides" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "background" TEXT NOT NULL DEFAULT 'navy',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "hero_slides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hero_slides_listing_id_key" ON "hero_slides"("listing_id");
CREATE INDEX "hero_slides_is_active_sort_order_idx" ON "hero_slides"("is_active", "sort_order");
