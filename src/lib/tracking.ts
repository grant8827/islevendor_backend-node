import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client';

/**
 * One row on an order's tracking timeline (see schema.prisma's
 * OrderTrackingEvent) — the warehouse/shop/reseller Orders tab's Tracking
 * sub-tab reads these to answer "the buyer says they never got it — what
 * actually happened?"
 *
 * Called at every status transition (orders.routes.ts's checkout,
 * ledger.service.ts's processWiPayWebhook/refundOrder, dispatch.routes.ts's
 * ready/delivered, dispatch.gateway.ts's driver:acceptJob) so the timeline
 * builds itself with no extra work at each call site beyond one line.
 * `postedBy` is set only for a driver's manual free-text note (see
 * dispatch.routes.ts's POST /orders/:id/note) — every automatic event
 * leaves it null.
 *
 * Takes a plain PrismaClient or a `tx` from $transaction — whichever the
 * caller is already using, so this never has to open its own transaction.
 */
export async function logTrackingEvent(
  db: PrismaClient | Prisma.TransactionClient,
  orderId: string,
  status: OrderStatus,
  opts: { note?: string; postedBy?: string } = {},
) {
  await db.orderTrackingEvent.create({
    data: { orderId, status, note: opts.note, postedBy: opts.postedBy },
  });
}
