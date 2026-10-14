import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { Prisma, type PaymentEventOutcome } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../env.js';
import { getSocketServer } from '../../lib/socket.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logTrackingEvent } from '../../lib/tracking.js';
import { canWithdrawFrom } from '../../lib/eligibility.js';
import { addBusinessDays, getPayoutTiming } from '../../lib/platformSettings.js';

export interface WiPayWebhookPayload {
  order_id: string;
  transaction_id: string;
  hash: string;
  status: string;
  [key: string]: unknown;
}

const WIPAY_PROVIDER = 'WIPAY';

/**
 * WiPay signs callbacks with an MD5 hash over a set of response fields + your
 * API key (see WiPay Jamaica merchant docs for the exact field order — this
 * is a placeholder until real sandbox credentials are wired in).
 */
export function verifyWiPayHash(payload: WiPayWebhookPayload): boolean {
  if (!env.WIPAY_API_KEY) {
    console.error('[wipay] WIPAY_API_KEY is not configured; rejecting callback');
    return false;
  }
  const expected = crypto
    .createHash('md5')
    .update(`${payload.transaction_id}${payload.order_id}${env.WIPAY_API_KEY}`)
    .digest('hex');
  return expected === payload.hash;
}

// Strict shape for the fields this code acts on. Anything else WiPay sends
// is kept verbatim on the PaymentEvent row, but never trusted.
const wipayWebhookSchema = z
  .object({
    order_id: z.string().uuid(),
    transaction_id: z.string().min(1).max(128),
    hash: z.string().min(1).max(128),
    status: z.string().min(1).max(32),
  })
  .passthrough();

/** Adds `amount` to an account's pending (in-escrow) balance. */
async function creditPending(tx: Prisma.TransactionClient, accountId: string, amount: Prisma.Decimal | string) {
  await tx.$executeRaw`
    UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${amount}::numeric WHERE id = ${accountId}::uuid
  `;
}

/**
 * Atomically:
 *  1. Verifies the WiPay signature.
 *  2. Records the callback as a PaymentEvent.
 *  3. Flips the order from AWAITING_PAYMENT -> PACKING.
 *  4. Records the HELD_IN_ESCROW ledger legs — three (warehouse/affiliate/
 *     platform) for an AFFILIATE order, two (shop/platform) for a STORE
 *     order, since a shop sells its own stock directly — and credits each
 *     recipient's pending balance.
 *  5. Notifies the seller (warehouse or shop) over WebSocket.
 *
 * Exactly-once, however many callbacks arrive and however they interleave:
 *  - The same callback redelivered (or a transaction id replayed against a
 *    different order) hits the PaymentEvent unique key and stops at step 2.
 *  - Two *different* transactions for one order queue on the order's row
 *    lock; the first moves it out of AWAITING_PAYMENT, so the second's
 *    conditional `status = AWAITING_PAYMENT` update at step 3 matches zero
 *    rows and stops.
 *  Only the winner of step 3 ever reaches step 4, so ledger rows and account
 *  balances can't diverge.
 */
export async function processWiPayWebhook(rawPayload: unknown) {
  if (!env.ENABLE_WIPAY_WEBHOOKS) {
    throw new HttpError(503, 'WiPay webhook processing is temporarily disabled');
  }
  const payload = wipayWebhookSchema.parse(rawPayload);
  if (!verifyWiPayHash(payload)) {
    throw new HttpError(400, 'Invalid WiPay signature');
  }

  const result = await prisma.$transaction(async (tx) => {
    // Row-lock the order before anything else, so callbacks for one order
    // are handled strictly one at a time. Not just tidiness: the PaymentEvent
    // insert below takes a key-share lock on this row through its foreign
    // key, and the status update further down needs a full row lock (it
    // writes the uniquely-indexed wipay_transaction_id) — two callbacks each
    // holding the first while waiting for the second would deadlock.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${payload.order_id}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: payload.order_id } });
    if (!order) throw new HttpError(404, 'Order not found for webhook payload');

    // skipDuplicates (ON CONFLICT DO NOTHING) rather than a caught unique
    // violation: a violation would abort this whole transaction. A concurrent
    // delivery of the same event waits here until the first commits, then
    // inserts nothing.
    const recorded = await tx.paymentEvent.createMany({
      data: [
        {
          provider: WIPAY_PROVIDER,
          providerEventId: payload.transaction_id,
          orderId: order.id,
          status: payload.status,
          payload: payload as Prisma.InputJsonObject,
        },
      ],
      skipDuplicates: true,
    });
    if (recorded.count === 0) {
      return { skipped: true as const, reason: 'duplicate webhook delivery' };
    }
    const setOutcome = (outcome: PaymentEventOutcome) =>
      tx.paymentEvent.update({
        where: { provider_providerEventId: { provider: WIPAY_PROVIDER, providerEventId: payload.transaction_id } },
        data: { outcome },
      });

    if (payload.status !== 'success') {
      // Nothing to credit — leave the order in AWAITING_PAYMENT for the
      // customer to retry, or let a cleanup job cancel it after a timeout.
      await setOutcome('IGNORED_NOT_SUCCESS');
      return { skipped: true as const, reason: 'payment not successful' };
    }

    const won = await tx.order.updateMany({
      where: { id: order.id, status: 'AWAITING_PAYMENT' },
      data: { status: 'PACKING', wipayTransactionId: payload.transaction_id },
    });
    if (won.count === 0) {
      // A second successful transaction against an order that's already paid
      // (or cancelled/refunded): money may have been taken twice. Nothing is
      // credited; the recorded event is what reconciliation works from.
      await setOutcome('IGNORED_ORDER_NOT_AWAITING_PAYMENT');
      console.error(
        `[wipay] success callback ${payload.transaction_id} for order ${order.id} ignored — order is not awaiting payment; needs reconciliation`,
      );
      return { skipped: true as const, reason: 'order is not awaiting payment' };
    }
    await logTrackingEvent(tx, order.id, 'PACKING', { note: 'Payment confirmed — now packing' });

    const platformAccount = await tx.ledgerAccount.findFirstOrThrow({ where: { accountType: 'PLATFORM' } });

    // No driver is assigned yet at payment time, so the driver's fee has
    // nowhere of its own to go — it's held on the platform account *combined
    // with* platform commission in a single leg (not two), because the
    // ledger's unique key is (order_id, recipient_account_id): two separate
    // rows against the same recipient would collide. Phase 4 (dispatch) must
    // split the driver's cut out of this combined balance into the driver's
    // own ledger account once a driver accepts the job.
    const platformHeldAmount = new Decimal(order.driverFeeJmd.toString()).plus(order.platformCommissionJmd.toString()).toFixed(2);

    // On a SELLER_DELIVERY order the business delivers it itself, so its own
    // delivery fee goes to whichever business packs it: the shop, or the
    // warehouse behind a reseller listing. Zero for every other method.
    const sellerDeliveryFee = new Decimal(order.sellerDeliveryFeeJmd.toString());

    let legs: { recipientAccountId: string; amountJmd: Prisma.Decimal | string }[];
    if (order.shopId) {
      // STORE order: the shop keeps resellerMarginJmd in full (it's the full
      // item revenue for a shop order, see orders.routes.ts), no separate
      // wholesale/warehouse leg exists.
      const shopAccount = await tx.ledgerAccount.findFirstOrThrow({
        where: { accountType: 'STORE', user: { shops: { some: { id: order.shopId } } } },
      });
      legs = [
        { recipientAccountId: shopAccount.id, amountJmd: new Decimal(order.resellerMarginJmd.toString()).plus(sellerDeliveryFee).toFixed(2) },
        { recipientAccountId: platformAccount.id, amountJmd: platformHeldAmount },
      ];
    } else {
      // AFFILIATE order: warehouse (wholesale) + affiliate (margin) +
      // driver/platform combined.
      const warehouseAccount = await tx.ledgerAccount.findFirstOrThrow({
        where: { accountType: 'WAREHOUSE', user: { warehouses: { some: { id: order.warehouseId! } } } },
      });
      const store = await tx.resellerStore.findUniqueOrThrow({ where: { id: order.resellerStoreId! }, select: { houseWarehouseId: true } });
      const warehouseLeg = new Decimal(order.wholesaleTotalJmd.toString()).plus(sellerDeliveryFee);

      if (store.houseWarehouseId) {
        // Sold on the warehouse's own house store: there's no reseller, so
        // the margin is the warehouse's too — one leg for both.
        legs = [
          { recipientAccountId: warehouseAccount.id, amountJmd: warehouseLeg.plus(order.resellerMarginJmd.toString()).toFixed(2) },
          { recipientAccountId: platformAccount.id, amountJmd: platformHeldAmount },
        ];
      } else {
        const resellerAccount = await tx.ledgerAccount.findFirstOrThrow({
          where: { accountType: 'RESELLER', user: { resellerStore: { id: order.resellerStoreId! } } },
        });
        legs = [
          { recipientAccountId: warehouseAccount.id, amountJmd: warehouseLeg.toFixed(2) },
          { recipientAccountId: resellerAccount.id, amountJmd: order.resellerMarginJmd },
          { recipientAccountId: platformAccount.id, amountJmd: platformHeldAmount },
        ];
      }
    }

    // Deliberately no skipDuplicates: this order just won the transition out
    // of AWAITING_PAYMENT, so legs can't already exist — if they somehow do,
    // failing (and rolling the whole thing back) beats crediting balances
    // for rows that were never inserted. Funds only move pending -> available
    // on delivery confirmation (see dispatch.routes.ts).
    await tx.ledgerTransaction.createMany({
      data: legs.map((leg) => ({ orderId: order.id, escrowState: 'HELD_IN_ESCROW' as const, ...leg })),
    });
    // Sorted so every transaction takes account row locks in the same order.
    for (const leg of [...legs].sort((a, b) => a.recipientAccountId.localeCompare(b.recipientAccountId))) {
      await creditPending(tx, leg.recipientAccountId, leg.amountJmd);
    }

    await setOutcome('APPLIED');
    return { order: await tx.order.findUniqueOrThrow({ where: { id: order.id } }) };
  });

  if (!('skipped' in result)) {
    const { order } = result;
    const room = order.shopId ? `shop_${order.shopId}` : `warehouse_${order.warehouseId}`;
    getSocketServer().to(room).emit('NEW_ORDER_TO_PACK', { orderId: order.id });
  }
  return result;
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
  if (!env.ENABLE_INTERNAL_REFUNDS) {
    throw new HttpError(503, 'Refund processing is temporarily disabled');
  }
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
    // payout, since withdrawBalance already took that leg out of the
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
 * Requests a withdrawal of everything `userId` has *available*: every leg
 * that delivery has released from escrow and that hasn't been refunded or
 * already withdrawn is swept into one new REQUESTED Payout per account, and
 * exactly that total comes off the account's available balance.
 *
 * Funds still HELD_IN_ESCROW are never touched — they aren't the seller's
 * until the order is delivered.
 *
 * A Payout is a request, not a payment: an IsleVendor admin sends the money
 * outside the platform and records it with settlePayout.
 */
export async function withdrawBalance(userId: string) {
  if (!env.ENABLE_WITHDRAWALS) {
    throw new HttpError(503, 'Withdrawals are temporarily disabled');
  }
  return prisma.$transaction(async (tx) => {
    const accounts = await tx.ledgerAccount.findMany({ where: { userId }, orderBy: { id: 'asc' } });
    if (accounts.length === 0) throw new HttpError(404, 'No ledger account found for this user');
    for (const account of accounts) {
      if (!(await canWithdrawFrom(userId, account.accountType))) {
        throw new HttpError(403, 'Withdrawals open once IsleVendor has approved your account');
      }
    }
    return requestPayouts(tx, accounts.map((a) => a.id));
  });
}

/**
 * IsleVendor's own withdrawal from the PLATFORM account: its commission and
 * anything else released to it. Driver fees aren't in here once delivered —
 * they move to the driver's own account (see releaseEscrowForOrder).
 */
export async function withdrawPlatformBalance() {
  if (!env.ENABLE_WITHDRAWALS) {
    throw new HttpError(503, 'Withdrawals are temporarily disabled');
  }
  return prisma.$transaction(async (tx) => {
    const platform = await tx.ledgerAccount.findFirstOrThrow({ where: { accountType: 'PLATFORM' } });
    return requestPayouts(tx, [platform.id]);
  });
}

/** One REQUESTED payout per account with anything available. Throws 409 if there's nothing. */
async function requestPayouts(tx: Prisma.TransactionClient, accountIds: string[]) {
  // Each payout is stamped with the date it should arrive by, from the
  // payout time IsleVendor advertises right now.
  const timing = await getPayoutTiming(tx);
  const payouts = [];
  for (const accountId of accountIds) {
    // Row-lock the account first: a second withdrawal racing this one
    // waits here, then sees these legs already attached to a payout.
    await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;

    const legs = await tx.ledgerTransaction.findMany({
      where: { recipientAccountId: accountId, escrowState: 'AVAILABLE', reversedAt: null, payoutId: null },
    });
    const total = legs.reduce((sum, leg) => sum.plus(leg.amountJmd.toString()), new Decimal(0));
    if (total.lessThanOrEqualTo(0)) continue;

    // The guard in the WHERE clause is what keeps the balance from ever
    // going negative. Legs adding up to more than the cached balance means
    // the two have drifted apart — stop and leave it for reconciliation
    // rather than pay out against either number.
    const debited = await tx.$executeRaw`
      UPDATE ledger_accounts
      SET available_balance_jmd = available_balance_jmd - ${total.toFixed(2)}::numeric
      WHERE id = ${accountId}::uuid AND available_balance_jmd >= ${total.toFixed(2)}::numeric
    `;
    if (debited === 0) {
      console.error(`[ledger] account ${accountId}: available legs total ${total.toFixed(2)} exceeds available balance; needs reconciliation`);
      throw new HttpError(409, 'Your balance is under review — please contact support before withdrawing');
    }

    const payout = await tx.payout.create({
      data: { ledgerAccountId: accountId, amountJmd: total.toFixed(2), expectedBy: addBusinessDays(new Date(), timing.maxBusinessDays) },
    });
    await tx.ledgerTransaction.updateMany({ where: { id: { in: legs.map((leg) => leg.id) } }, data: { payoutId: payout.id } });
    payouts.push(payout);
  }

  if (payouts.length === 0) {
    throw new HttpError(409, 'Nothing available to withdraw');
  }
  return payouts;
}

/**
 * Records how a payout request was settled, once an IsleVendor admin has
 * sent (or failed to send) the money outside the platform:
 *  - PAID: the money went out; `reference` is the bank/Lynk transfer reference.
 *  - FAILED: it didn't; the legs return to the account's available balance,
 *    so the owner can withdraw them again.
 * Only a REQUESTED payout can be settled, and only once — the conditional
 * update is the race-decider.
 */
export async function settlePayout(
  tx: Prisma.TransactionClient,
  payoutId: string,
  outcome: { status: 'PAID'; reference: string; note?: string } | { status: 'FAILED'; note: string; reference?: string },
  adminId: string,
) {
  const settled = await tx.payout.updateMany({
    where: { id: payoutId, status: 'REQUESTED' },
    data: { status: outcome.status, reference: outcome.reference ?? null, note: outcome.note ?? null, settledAt: new Date(), settledBy: adminId },
  });
  if (settled.count === 0) {
    const exists = await tx.payout.count({ where: { id: payoutId } });
    throw new HttpError(exists ? 409 : 404, exists ? 'This payout has already been settled' : 'Payout not found');
  }

  const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
  if (outcome.status === 'FAILED') {
    await tx.ledgerTransaction.updateMany({ where: { payoutId }, data: { payoutId: null } });
    await tx.$executeRaw`
      UPDATE ledger_accounts SET available_balance_jmd = available_balance_jmd + ${payout.amountJmd} WHERE id = ${payout.ledgerAccountId}::uuid
    `;
  }
  return payout;
}

/**
 * Escrow release: moves every leg of a just-delivered order from pending to
 * available, so it can be withdrawn (see withdrawBalance). Call inside the
 * same transaction that moved the order to DELIVERED — that conditional
 * transition is what guarantees this runs once per order. Moves the balance
 * columns and the escrow_state label together; refundOrder decides which
 * column to subtract from based on escrow_state, so they must agree.
 *
 * Does nothing while ENABLE_ESCROW_RELEASE is off.
 */
export async function releaseEscrowForOrder(tx: Prisma.TransactionClient, orderId: string) {
  if (!env.ENABLE_ESCROW_RELEASE) return;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { driverId: true, driverFeeJmd: true } });
  const legs = await tx.ledgerTransaction.findMany({
    where: { orderId, escrowState: 'HELD_IN_ESCROW', reversedAt: null, payoutId: null },
    include: { recipientAccount: { select: { accountType: true } } },
    orderBy: { recipientAccountId: 'asc' },
  });

  // The IsleDash fee was held on the platform's leg at payment time, before
  // anyone knew who'd deliver. Now the driver is known, it becomes theirs:
  // the platform leg shrinks by the fee and the driver gets a leg of their
  // own, so the platform's available balance is only ever IsleVendor's.
  const driverFee = new Decimal(order.driverFeeJmd.toString());
  const driverAccountId = order.driverId && driverFee.greaterThan(0) ? (await driverLedgerAccount(tx, order.driverId)).id : null;

  for (const leg of legs) {
    let available = new Decimal(leg.amountJmd.toString());
    if (driverAccountId && leg.recipientAccount.accountType === 'PLATFORM') {
      available = available.minus(driverFee);
      await tx.ledgerTransaction.update({ where: { id: leg.id }, data: { amountJmd: available.toFixed(2) } });
    }
    await tx.$executeRaw`
      UPDATE ledger_accounts
      SET pending_balance_jmd = pending_balance_jmd - ${leg.amountJmd}, available_balance_jmd = available_balance_jmd + ${available.toFixed(2)}::numeric
      WHERE id = ${leg.recipientAccountId}::uuid;
    `;
  }
  await tx.ledgerTransaction.updateMany({
    where: { id: { in: legs.map((leg) => leg.id) } },
    data: { escrowState: 'AVAILABLE' },
  });

  if (driverAccountId && legs.some((leg) => leg.recipientAccount.accountType === 'PLATFORM')) {
    await tx.ledgerTransaction.create({
      data: { orderId, recipientAccountId: driverAccountId, amountJmd: driverFee.toFixed(2), escrowState: 'AVAILABLE' },
    });
    await tx.$executeRaw`
      UPDATE ledger_accounts SET available_balance_jmd = available_balance_jmd + ${driverFee.toFixed(2)}::numeric WHERE id = ${driverAccountId}::uuid
    `;
  }
}

/** The driver's ledger account — created now if their sign-up predates it. */
async function driverLedgerAccount(tx: Prisma.TransactionClient, driverUserId: string) {
  return (
    (await tx.ledgerAccount.findFirst({ where: { userId: driverUserId, accountType: 'DRIVER' } })) ??
    (await tx.ledgerAccount.create({ data: { userId: driverUserId, accountType: 'DRIVER' } }))
  );
}
