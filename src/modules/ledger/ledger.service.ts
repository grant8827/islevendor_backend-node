import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../env.js';
import { getSocketServer } from '../../lib/socket.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logTrackingEvent } from '../../lib/tracking.js';

export interface WiPayWebhookPayload {
  order_id: string;
  transaction_id: string;
  hash: string;
  status: 'success' | 'failed';
  [key: string]: unknown;
}

/**
 * WiPay signs callbacks with an MD5 hash over a set of response fields + your
 * API key (see WiPay Jamaica merchant docs for the exact field order — this
 * is a placeholder until real sandbox credentials are wired in).
 */
export function verifyWiPayHash(payload: WiPayWebhookPayload): boolean {
  if (!env.WIPAY_API_KEY) {
    console.warn('[wipay] WIPAY_API_KEY not set — skipping hash verification (dev only)');
    return env.NODE_ENV !== 'production';
  }
  const expected = crypto
    .createHash('md5')
    .update(`${payload.transaction_id}${payload.order_id}${env.WIPAY_API_KEY}`)
    .digest('hex');
  return expected === payload.hash;
}

/**
 * Atomically:
 *  1. Verifies the WiPay signature.
 *  2. Records the HELD_IN_ESCROW ledger legs — four (warehouse/affiliate/
 *     driver/platform) for an AFFILIATE order, three (shop/driver/platform)
 *     for a STORE order, since a shop sells its own stock directly.
 *  3. Flips the order from AWAITING_PAYMENT -> PACKING.
 *  4. Notifies the seller (warehouse or shop) over WebSocket.
 *
 * Idempotent: relies on `orders.wipay_transaction_id` UNIQUE and
 * `ledger_transactions (order_id, recipient_account_id)` UNIQUE so a retried
 * webhook delivery is a no-op rather than a double-credit.
 */
export async function processWiPayWebhook(payload: WiPayWebhookPayload) {
  if (!verifyWiPayHash(payload)) {
    throw new HttpError(400, 'Invalid WiPay signature');
  }
  if (payload.status !== 'success') {
    // Nothing to disburse — leave the order in AWAITING_PAYMENT for the
    // customer to retry, or let a cleanup job cancel it after a timeout.
    return { skipped: true, reason: 'payment not successful' };
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: payload.order_id } });
      if (!order) throw new HttpError(404, 'Order not found for webhook payload');
      if (order.status !== 'AWAITING_PAYMENT') {
        // Already processed by a prior webhook delivery — idempotent no-op.
        return order;
      }

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: 'PACKING', wipayTransactionId: payload.transaction_id },
      });
      await logTrackingEvent(tx, order.id, 'PACKING', { note: 'Payment confirmed — now packing' });

      const platformAccount = await tx.ledgerAccount.findFirstOrThrow({ where: { accountType: 'PLATFORM' } });

      // No driver is assigned yet at payment time, so the driver's fee has
      // nowhere of its own to go — it's held on the platform account *combined
      // with* platform commission in a single leg (not two), because the
      // ledger's idempotency key is (order_id, recipient_account_id): two
      // separate rows against the same recipient would collide and, with
      // skipDuplicates, silently drop one of them — which is exactly the bug
      // this replaced (platform commission was vanishing under a real driver
      // fee row). Phase 4 (dispatch) must split the driver's cut out of this
      // combined balance into the driver's own ledger account once a driver
      // accepts the job.
      const platformHeldAmount = new Decimal(order.driverFeeJmd.toString()).plus(order.platformCommissionJmd.toString());

      if (order.shopId) {
        // STORE order: 3-way split — the shop keeps resellerMarginJmd in
        // full (it's the full item revenue for a shop order, see
        // orders.routes.ts), no separate wholesale/warehouse leg exists.
        const shopAccount = await tx.ledgerAccount.findFirstOrThrow({
          where: { accountType: 'STORE', user: { shops: { some: { id: order.shopId } } } },
        });

        await tx.ledgerTransaction.createMany({
          data: [
            { orderId: order.id, recipientAccountId: shopAccount.id, amountJmd: order.resellerMarginJmd, escrowState: 'HELD_IN_ESCROW' },
            { orderId: order.id, recipientAccountId: platformAccount.id, amountJmd: platformHeldAmount.toFixed(2), escrowState: 'HELD_IN_ESCROW' },
          ],
          skipDuplicates: true,
        });

        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.resellerMarginJmd} WHERE id = ${shopAccount.id}::uuid;
        `;
        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${platformHeldAmount.toFixed(2)}::numeric WHERE id = ${platformAccount.id}::uuid;
        `;
      } else {
        // AFFILIATE order: 4-way split — warehouse (wholesale) + affiliate
        // (margin) + driver/platform combined.
        const [warehouseAccount, resellerAccount] = await Promise.all([
          tx.ledgerAccount.findFirstOrThrow({
            where: { accountType: 'WAREHOUSE', user: { warehouses: { some: { id: order.warehouseId! } } } },
          }),
          tx.ledgerAccount.findFirstOrThrow({
            where: { accountType: 'RESELLER', user: { resellerStore: { id: order.resellerStoreId! } } },
          }),
        ]);

        await tx.ledgerTransaction.createMany({
          data: [
            { orderId: order.id, recipientAccountId: warehouseAccount.id, amountJmd: order.wholesaleTotalJmd, escrowState: 'HELD_IN_ESCROW' },
            { orderId: order.id, recipientAccountId: resellerAccount.id, amountJmd: order.resellerMarginJmd, escrowState: 'HELD_IN_ESCROW' },
            { orderId: order.id, recipientAccountId: platformAccount.id, amountJmd: platformHeldAmount.toFixed(2), escrowState: 'HELD_IN_ESCROW' },
          ],
          skipDuplicates: true, // guards against a retried webhook delivery re-inserting the same rows
        });

        // Move pending -> available only happens on delivery confirmation
        // (Domain D) — here we just move funds into pending_balance_jmd.
        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.wholesaleTotalJmd} WHERE id = ${warehouseAccount.id}::uuid;
        `;
        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.resellerMarginJmd} WHERE id = ${resellerAccount.id}::uuid;
        `;
        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${platformHeldAmount.toFixed(2)}::numeric WHERE id = ${platformAccount.id}::uuid;
        `;
      }

      return updatedOrder;
    });

    const room = order.shopId ? `shop_${order.shopId}` : `warehouse_${order.warehouseId}`;
    getSocketServer().to(room).emit('NEW_ORDER_TO_PACK', { orderId: order.id });
    return { order };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Unique constraint hit — a concurrent duplicate delivery of the same
      // webhook. Safe to swallow: the first delivery already did the work.
      return { skipped: true, reason: 'duplicate webhook delivery' };
    }
    throw err;
  }
}

/**
 * Reverses an order: unwinds every ledger leg it credited (warehouse/shop +
 * reseller + platform's combined driver/commission leg) back off whichever
 * balance currently holds it, records a Refund for the audit trail, and
 * flips the order to REFUNDED.
 *
 * Internal bookkeeping only, same caveat as the rest of this file — WiPay
 * checkout itself isn't wired up yet (see orders.routes.ts's TODO), so
 * there's no live payment-processor call to make; this just makes the
 * platform's own books agree that the money went back.
 *
 * Callers (warehouse.routes.ts, shop.routes.ts) are responsible for
 * ownership/role checks before calling this — it only checks the order's
 * own state.
 */
export async function refundOrder(orderId: string, initiatedByUserId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.status === 'AWAITING_PAYMENT') {
      throw new HttpError(409, 'This order was never paid for — there is nothing to refund');
    }
    if (order.status === 'REFUNDED') {
      throw new HttpError(409, 'This order has already been refunded');
    }

    // Only unwind legs not already reversed — defensive against this ever
    // being called twice for the same order (the REFUNDED check above
    // already guards the normal path) — and not already swept into a
    // payout, since withdrawBalance already zeroed that leg out of the
    // account's balance; there's nothing left there to subtract back out.
    const legs = await tx.ledgerTransaction.findMany({ where: { orderId, reversedAt: null, payoutId: null } });
    for (const leg of legs) {
      if (leg.escrowState === 'HELD_IN_ESCROW') {
        await tx.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd - ${leg.amountJmd} WHERE id = ${leg.recipientAccountId}::uuid;
        `;
      } else {
        await tx.$executeRaw`
          UPDATE ledger_accounts SET available_balance_jmd = available_balance_jmd - ${leg.amountJmd} WHERE id = ${leg.recipientAccountId}::uuid;
        `;
      }
      await tx.ledgerTransaction.update({ where: { id: leg.id }, data: { reversedAt: new Date() } });
    }

    await tx.refund.create({
      data: { orderId, amountJmd: order.totalPaidJmd, reason, initiatedBy: initiatedByUserId },
    });
    await logTrackingEvent(tx, orderId, 'REFUNDED', { note: reason, postedBy: initiatedByUserId });

    return tx.order.update({ where: { id: orderId }, data: { status: 'REFUNDED' } });
  });
}

/**
 * Withdraws everything currently sitting in `userId`'s ledger account(s):
 * sweeps every leg not already withdrawn or refunded into one new Payout
 * record, zeroes the corresponding balance column(s), and moves those legs
 * from the Payout tab's "available to withdraw" list to Payout History.
 *
 * Internal bookkeeping only — same caveat as refundOrder above, there's no
 * live bank/Lynk disbursement wired up yet, so "withdraw" just means "no
 * longer sitting in the pending/available balance, now recorded as paid
 * out." Pulls from pending_balance_jmd as well as available_balance_jmd
 * since nothing in this codebase yet moves funds from pending -> available
 * (that's the delivery-confirmation step noted in processWiPayWebhook,
 * Domain D) — gating withdrawal on available_balance_jmd alone would make
 * it permanently a no-op today.
 */
export async function withdrawBalance(userId: string) {
  return prisma.$transaction(async (tx) => {
    const accounts = await tx.ledgerAccount.findMany({ where: { userId } });
    if (accounts.length === 0) throw new HttpError(404, 'No ledger account found for this user');

    const payouts = [];
    for (const account of accounts) {
      const legs = await tx.ledgerTransaction.findMany({
        where: { recipientAccountId: account.id, reversedAt: null, payoutId: null },
      });
      const total = legs.reduce((sum, leg) => sum.plus(leg.amountJmd.toString()), new Decimal(0));
      if (total.lessThanOrEqualTo(0)) continue;

      const payout = await tx.payout.create({
        data: { ledgerAccountId: account.id, amountJmd: total.toFixed(2) },
      });
      await tx.ledgerTransaction.updateMany({
        where: { id: { in: legs.map((leg) => leg.id) } },
        data: { payoutId: payout.id },
      });
      await tx.$executeRaw`
        UPDATE ledger_accounts SET pending_balance_jmd = 0, available_balance_jmd = 0 WHERE id = ${account.id}::uuid;
      `;
      payouts.push(payout);
    }

    if (payouts.length === 0) {
      throw new HttpError(409, 'Nothing available to withdraw');
    }
    return payouts;
  });
}
