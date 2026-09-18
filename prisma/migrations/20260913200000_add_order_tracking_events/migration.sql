-- The timeline the warehouse/shop/reseller side reads to answer "the buyer
-- says they never got it — what actually happened?" One row per automatic
-- status-change event, plus optional free-text notes a driver posts
-- manually (see src/lib/tracking.ts and dispatch.routes.ts's POST
-- /orders/:id/note).
CREATE TABLE "order_tracking_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" TEXT,
    "posted_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tracking_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_tracking_events" ADD CONSTRAINT "order_tracking_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_tracking_events" ADD CONSTRAINT "order_tracking_events_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
