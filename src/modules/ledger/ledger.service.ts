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
import { missingForAutomaticPayout, revealForPayout, snapshotOf } from '../../lib/payoutAccounts.js';
import { WIPAY_ID_TYPES } from '../../lib/wipayBanks.js';
import {
  createSubBankedWithdrawal,
  findWithdrawals,
  interpretStatus,
  retrieveWithdrawal,
  WiPayRejectedError,
  WiPayUncertainError,
  type WiPayWithdrawal,
} from '../../lib/wipayPayouts.js';
import { addBusinessDays, automatedPayoutsEnabled, getPayoutTiming } from '../../lib/platformSettings.js';

const WIPAY_PROVIDER = 'WIPAY';

/** Adds `amount` to an account's pending (in-escrow) balance. */
async function creditPending(tx: Prisma.TransactionClient, accountId: string, amount: Prisma.Decimal | string) {
  await tx.$executeRaw`
    UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${amount}::numeric WHERE id = ${accountId}::uuid
  `;
}

/**
 * Credits one order for a confirmed WiPay payment, inside the caller's
 * transaction (see modules/payments, which verifies the payment first):
 *  1. Records the event as a PaymentEvent keyed by WiPay's transaction and
 *     this order, so a redelivery is a no-op.
 *  2. Flips the order from AWAITING_PAYMENT -> PACKING.
 *  3. Records the HELD_IN_ESCROW ledger legs — warehouse/affiliate/platform
 *     for an AFFILIATE order, shop/platform for a STORE order — and credits
 *     each recipient's pending balance.
 *
 * Exactly-once however callbacks interleave: the order row is locked first,
 * the event key stops redeliveries, and the conditional AWAITING_PAYMENT
 * transition stops a second transaction for an already-paid order — only
 * its winner reaches the ledger. Returns whether this call credited it; the
 * caller tells the seller once the transaction commits.
 */
export async function creditOrderPayment(
  tx: Prisma.TransactionClient,
  orderId: string,
  event: { transactionId: string; status: string; payload: Prisma.InputJsonObject },
) {
  // Row-lock the order before anything else, so callbacks for one order
  // are handled strictly one at a time. Not just tidiness: the PaymentEvent
  // insert below takes a key-share lock on this row through its foreign
  // key, and the status update further down needs a full row lock (it
  // writes the uniquely-indexed wipay_transaction_id) — two callbacks each
  // holding the first while waiting for the second would deadlock.
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw new HttpError(404, 'Order not found for webhook payload');

  // skipDuplicates (ON CONFLICT DO NOTHING) rather than a caught unique
  // violation: a violation would abort this whole transaction. A concurrent
  // delivery of the same event waits here until the first commits, then
  // inserts nothing.
  const recorded = await tx.paymentEvent.createMany({
    data: [
      {
        provider: WIPAY_PROVIDER,
        // One WiPay transaction can pay several orders, so the event key is
        // the transaction and the order together.
        providerEventId: `${event.transactionId}:${orderId}`,
        orderId: order.id,
        status: event.status,
        payload: event.payload,
      },
    ],
    skipDuplicates: true,
  });
  if (recorded.count === 0) {
    return { skipped: true as const, reason: 'duplicate webhook delivery' };
  }
  const setOutcome = (outcome: PaymentEventOutcome) =>
    tx.paymentEvent.update({
      where: { provider_providerEventId: { provider: WIPAY_PROVIDER, providerEventId: `${event.transactionId}:${orderId}` } },
      data: { outcome },
    });

  if (event.status !== 'success') {
    // Nothing to credit — leave the order in AWAITING_PAYMENT for the
    // customer to retry, or let a cleanup job cancel it after a timeout.
    await setOutcome('IGNORED_NOT_SUCCESS');
    return { skipped: true as const, reason: 'payment not successful' };
  }

  const won = await tx.order.updateMany({
    where: { id: order.id, status: 'AWAITING_PAYMENT' },
    data: { status: 'PACKING', wipayTransactionId: event.transactionId },
  });
  if (won.count === 0) {
    // A second successful transaction against an order that's already paid
    // (or cancelled/refunded): money may have been taken twice. Nothing is
    // credited; the recorded event is what reconciliation works from.
    await setOutcome('IGNORED_ORDER_NOT_AWAITING_PAYMENT');
    console.error(
      `[wipay] payment ${event.transactionId} for order ${order.id} ignored — order is not awaiting payment; needs reconciliation`,
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
}

/** Tells the seller an order is paid and ready to pack — call after the crediting transaction commits. */
export function notifySellerOfPaidOrder(order: { id: string; shopId: string | null; warehouseId: string | null }) {
  const room = order.shopId ? `shop_${order.shopId}` : `warehouse_${order.warehouseId}`;
  try {
    getSocketServer().to(room).emit('NEW_ORDER_TO_PACK', { orderId: order.id });
  } catch {
    // No socket server (a script) — the seller sees it on their next load.
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
 * Records how a payout was settled by hand, once an IsleVendor admin has
 * sent (or failed to send) the money outside the platform:
 *  - PAID: the money went out; `reference` is the bank/Lynk transfer reference.
 *  - FAILED: it didn't; the legs return to the account's available balance,
 *    so the owner can withdraw them again.
 * Works on a REQUESTED or APPROVED payout, once — the conditional update is
 * the race-decider. A payout already sent to WiPay is settled by WiPay's
 * own status instead (see applyWiPayStatus), never by hand.
 */
export async function settlePayout(
  tx: Prisma.TransactionClient,
  payoutId: string,
  outcome: { status: 'PAID'; reference: string; note?: string } | { status: 'FAILED'; note: string; reference?: string },
  adminId: string,
) {
  const settled = await tx.payout.updateMany({
    where: { id: payoutId, status: { in: ['REQUESTED', 'APPROVED'] } },
    data: {
      status: outcome.status,
      channel: 'MANUAL',
      reference: outcome.reference ?? null,
      note: outcome.note ?? null,
      settledAt: new Date(),
      settledBy: adminId,
    },
  });
  if (settled.count === 0) {
    const existing = await tx.payout.findUnique({ where: { id: payoutId } });
    if (!existing) throw new HttpError(404, 'Payout not found');
    if (existing.status === 'SUBMITTED' || existing.status === 'PROCESSING') {
      throw new HttpError(409, 'This payout was sent through WiPay — its outcome comes from WiPay. Use "Check with WiPay".');
    }
    throw new HttpError(409, 'This payout has already been settled');
  }

  const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
  if (outcome.status === 'FAILED') await returnPayoutFunds(tx, payout);
  return payout;
}

/** A failed payout's money goes back: its legs are freed and the account's available balance restored. */
async function returnPayoutFunds(tx: Prisma.TransactionClient, payout: { id: string; amountJmd: Prisma.Decimal; ledgerAccountId: string }) {
  await tx.ledgerTransaction.updateMany({ where: { payoutId: payout.id }, data: { payoutId: null } });
  await tx.$executeRaw`
    UPDATE ledger_accounts SET available_balance_jmd = available_balance_jmd + ${payout.amountJmd} WHERE id = ${payout.ledgerAccountId}::uuid
  `;
}

/**
 * An admin approves a payout request: it's been checked and can be paid,
 * by hand or (if enabled) through WiPay. Records where it's going, masked.
 */
export async function approvePayout(tx: Prisma.TransactionClient, payoutId: string, adminId: string) {
  const payout = await tx.payout.findUnique({ where: { id: payoutId }, include: { ledgerAccount: true } });
  if (!payout) throw new HttpError(404, 'Payout not found');
  const destination = payout.ledgerAccount.userId ? await tx.payoutAccount.findUnique({ where: { userId: payout.ledgerAccount.userId } }) : null;

  const approved = await tx.payout.updateMany({
    where: { id: payoutId, status: 'REQUESTED' },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      approvedBy: adminId,
      destinationSnapshot: destination ? snapshotOf(destination) : payout.ledgerAccount.accountType === 'PLATFORM' ? { owner: 'IsleVendor' } : Prisma.DbNull,
    },
  });
  if (approved.count === 0) throw new HttpError(409, 'Only a payout waiting for approval can be approved');
  return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
}

// ── Automated payouts through WiPay ─────────────────────────────────────────
//
// APPROVED -> SUBMITTED (we're about to ask WiPay; committed before the call
// so two clicks can't both send) -> PROCESSING (WiPay accepted it) -> PAID
// or FAILED by WiPay's own withdrawal status, never by our request being
// accepted. If we can't tell whether WiPay accepted a submission (timeout,
// 5xx), it stays SUBMITTED until checkWiPayPayout has looked it up in WiPay's
// records — a payout is never sent twice on a guess.

async function assertAutomatedPayoutsEnabled() {
  if (!(await automatedPayoutsEnabled())) throw new HttpError(503, 'Automatic WiPay payouts are switched off — pay this one by hand');
}

// How long after a submission WiPay's records are trusted to show it, before
// "not there" is taken to mean it was never accepted.
const SUBMISSION_SETTLE_MS = 15 * 60 * 1000;

export async function submitPayoutToWiPay(payoutId: string, adminId: string) {
  await assertAutomatedPayoutsEnabled();

  // Claim it: APPROVED -> SUBMITTED with a fresh submission key, committed
  // before WiPay is called.
  const { payout, account } = await prisma.$transaction(async (tx) => {
    const current = await tx.payout.findUnique({ where: { id: payoutId }, include: { ledgerAccount: true } });
    if (!current) throw new HttpError(404, 'Payout not found');
    if (current.status !== 'APPROVED') throw new HttpError(409, 'Only an approved payout can be sent through WiPay');
    if (!current.ledgerAccount.userId) throw new HttpError(409, "IsleVendor's own withdrawals are paid by hand");
    const destination = await tx.payoutAccount.findUnique({ where: { userId: current.ledgerAccount.userId } });
    const missing = destination ? missingForAutomaticPayout(destination) : ['payout details'];
    if (missing.length) throw new HttpError(409, `This person's payout details aren't complete for WiPay: missing ${missing.join(', ')}`);

    const claimed = await tx.payout.updateMany({
      where: { id: payoutId, status: 'APPROVED' },
      data: { status: 'SUBMITTED', channel: 'WIPAY', submissionKey: crypto.randomUUID(), submittedAt: new Date(), lastError: null, destinationSnapshot: snapshotOf(destination!) },
    });
    if (claimed.count === 0) throw new HttpError(409, 'This payout is already being sent');
    return { payout: await tx.payout.findUniqueOrThrow({ where: { id: payoutId } }), account: destination! };
  });

  const details = revealForPayout(account);
  try {
    const withdrawal = await createSubBankedWithdrawal({
      amountJmd: payout.amountJmd.toFixed(2),
      email: details.email!,
      phone: details.phone!,
      bankName: details.bankName!,
      bankAccount: details.accountNumber!,
      bankAccountType: details.bankAccountType === 'SAVINGS' ? 'savings' : 'chequing',
      bankBranch: details.bankBranch!,
      nameInBank: details.nameInBank!,
      idType: WIPAY_ID_TYPES[details.idType!].wipay,
      idNumber: details.idNumber!,
      data: JSON.stringify({ payoutId: payout.id, submissionKey: payout.submissionKey }),
    });
    // Accepted — which only means WiPay will try. It's PROCESSING until
    // WiPay's status says otherwise.
    return prisma.$transaction((tx) => recordWiPayWithdrawal(tx, payout.id, withdrawal));
  } catch (err) {
    if (err instanceof WiPayRejectedError) {
      // Definitely not created: back to APPROVED, free to fix and send again.
      await prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'APPROVED', channel: null, submissionKey: null, submittedAt: null, lastError: `WiPay refused it: ${err.message}` },
      });
      throw new HttpError(422, `WiPay refused this payout: ${err.message}`);
    }
    if (err instanceof WiPayUncertainError) {
      await prisma.payout.update({
        where: { id: payout.id },
        data: { lastError: `${err.message}. It may or may not have gone through — use "Check with WiPay" before doing anything else.` },
      });
      throw new HttpError(504, 'WiPay didn’t answer — the payout may or may not have been accepted. Use "Check with WiPay"; don’t send it again yet.');
    }
    throw err;
  }
}

/**
 * Asks WiPay where a payout stands and applies it. For a submission whose
 * outcome we never heard, looks it up in WiPay's withdrawal history by our
 * submission key first; only once enough time has passed and WiPay has no
 * record of it is it released back to APPROVED to be sent again.
 */
export async function checkWiPayPayout(payoutId: string) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!payout) throw new HttpError(404, 'Payout not found');
  if (payout.channel !== 'WIPAY' || !['SUBMITTED', 'PROCESSING'].includes(payout.status)) {
    throw new HttpError(409, 'This payout isn’t waiting on WiPay');
  }

  if (payout.providerTransactionId) {
    const withdrawal = await retrieveWithdrawal(payout.providerTransactionId);
    return prisma.$transaction((tx) => recordWiPayWithdrawal(tx, payout.id, withdrawal));
  }

  const found = (await findWithdrawals({ amountJmd: payout.amountJmd.toFixed(2), since: payout.submittedAt! })).find((w) =>
    w.data?.includes(payout.submissionKey!),
  );
  if (found) return prisma.$transaction((tx) => recordWiPayWithdrawal(tx, payout.id, found));

  if (Date.now() - payout.submittedAt!.getTime() < SUBMISSION_SETTLE_MS) {
    throw new HttpError(409, 'WiPay doesn’t show this payout yet. Check again in a few minutes before sending it again.');
  }
  // Verified: WiPay never accepted it. Safe to send again, with a new key.
  return prisma.payout.update({
    where: { id: payout.id },
    data: {
      status: 'APPROVED',
      channel: null,
      submissionKey: null,
      submittedAt: null,
      providerCheckedAt: new Date(),
      lastError: 'WiPay has no record of the earlier attempt, so it was never sent. It can be sent again.',
    },
  });
}

/**
 * Applies a WiPay withdrawal record to its payout: WiPay's transaction id,
 * status and fee, then — by that status alone — PAID (status 2), FAILED
 * with the money returned to the owner (status 5), or still PROCESSING.
 * Only moves a payout that's with WiPay, and only forward.
 */
export async function recordWiPayWithdrawal(tx: Prisma.TransactionClient, payoutId: string, withdrawal: WiPayWithdrawal) {
  const payout = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
  const outcome = interpretStatus(withdrawal.status);
  const provider = {
    providerTransactionId: withdrawal.transaction_id ?? payout.providerTransactionId,
    providerReference: withdrawal.reference ?? payout.providerReference,
    providerStatus: withdrawal.status ?? payout.providerStatus,
    providerStatusDescription: withdrawal.status_description ?? payout.providerStatusDescription,
    providerFeeJmd: withdrawal.fee_amount ?? payout.providerFeeJmd,
    providerCheckedAt: new Date(),
    lastError: null,
  };
  const inFlight = { id: payoutId, status: { in: ['SUBMITTED', 'PROCESSING'] as ('SUBMITTED' | 'PROCESSING')[] } };

  if (outcome === 'PAID') {
    await tx.payout.updateMany({ where: inFlight, data: { ...provider, status: 'PAID', settledAt: new Date(), reference: provider.providerReference ?? provider.providerTransactionId } });
  } else if (outcome === 'FAILED') {
    const failed = await tx.payout.updateMany({
      where: inFlight,
      data: { ...provider, status: 'FAILED', settledAt: new Date(), note: `WiPay: ${withdrawal.status_description ?? 'returned to IsleVendor'}` },
    });
    if (failed.count === 1) await returnPayoutFunds(tx, payout);
  } else {
    await tx.payout.updateMany({ where: inFlight, data: { ...provider, status: 'PROCESSING' } });
  }
  return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * A withdrawal notification from WiPay. Verifies the signature (HMAC-SHA256
 * of "<timestamp>.<raw body>" with the endpoint's signing secret, per
 * https://docs.wipayfinancial.com/webhooks) and its age, skips an event
 * already handled, then — rather than trusting the payload's status —
 * fetches the withdrawal from WiPay and applies that.
 *
 * Returns normally once the event is durably handled (the caller answers
 * 2xx); throws to make WiPay retry.
 */
export async function processWiPayPayoutWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  if (!env.WIPAY_PAYOUT_WEBHOOK_SECRET) throw new HttpError(503, 'WiPay payout notifications are not configured');
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const signature = header('x-wipay-webhook-signature') ?? '';
  const timestamp = Number(header('x-wipay-webhook-timestamp'));
  if (!signature.startsWith('sha256=') || !Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new HttpError(400, 'Invalid or expired WiPay signature');
  }
  const expected = Buffer.from(crypto.createHmac('sha256', env.WIPAY_PAYOUT_WEBHOOK_SECRET).update(`${timestamp}.`).update(rawBody).digest('hex'));
  const provided = Buffer.from(signature.slice('sha256='.length).toLowerCase());
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new HttpError(400, 'Invalid or expired WiPay signature');
  }

  const envelope = z
    .object({ id: z.string().min(1).max(255), event: z.string().max(100), data: z.record(z.unknown()).optional() })
    .passthrough()
    .parse(JSON.parse(rawBody.toString('utf8')));
  if (await prisma.payoutWebhookEvent.findUnique({ where: { providerEventId: envelope.id } })) {
    return { duplicate: true };
  }

  let payoutId: string | null = null;
  let outcome = 'ignored';
  if (envelope.event.startsWith('withdrawal.') && envelope.data) {
    const transactionId = typeof envelope.data.transaction_id === 'string' ? envelope.data.transaction_id : null;
    let fromData: string | null = null;
    try {
      fromData = typeof envelope.data.data === 'string' ? (JSON.parse(envelope.data.data).payoutId ?? null) : null;
    } catch {
      // Someone else's pass-through data — not one of ours.
    }
    const payout = await prisma.payout.findFirst({
      where: { OR: [...(transactionId ? [{ providerTransactionId: transactionId }] : []), ...(fromData && /^[0-9a-f-]{36}$/i.test(fromData) ? [{ id: fromData }] : [])] },
    });
    if (!payout) {
      outcome = 'unmatched';
    } else if (payout.channel === 'WIPAY' && ['SUBMITTED', 'PROCESSING'].includes(payout.status)) {
      // The notification says something changed; WiPay's own record says what.
      const withdrawal = await retrieveWithdrawal(transactionId ?? payout.providerTransactionId!);
      await prisma.$transaction((tx) => recordWiPayWithdrawal(tx, payout.id, withdrawal));
      payoutId = payout.id;
      outcome = 'applied';
    } else {
      payoutId = payout.id;
      outcome = 'already_settled';
    }
  }

  await prisma.payoutWebhookEvent.createMany({
    data: [{ providerEventId: envelope.id, event: envelope.event, payoutId, outcome, payload: envelope as Prisma.InputJsonObject }],
    skipDuplicates: true,
  });
  return { outcome };
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
