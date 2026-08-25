import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../env.js';
import { getSocketServer } from '../../lib/socket.js';
import { HttpError } from '../../middleware/errorHandler.js';
/**
 * WiPay signs callbacks with an MD5 hash over a set of response fields + your
 * API key (see WiPay Jamaica merchant docs for the exact field order — this
 * is a placeholder until real sandbox credentials are wired in).
 */
export function verifyWiPayHash(payload) {
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
export async function processWiPayWebhook(payload) {
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
            if (!order)
                throw new HttpError(404, 'Order not found for webhook payload');
            if (order.status !== 'AWAITING_PAYMENT') {
                // Already processed by a prior webhook delivery — idempotent no-op.
                return order;
            }
            const updatedOrder = await tx.order.update({
                where: { id: order.id },
                data: { status: 'PACKING', wipayTransactionId: payload.transaction_id },
            });
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
                await tx.$executeRaw `
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.resellerMarginJmd} WHERE id = ${shopAccount.id}::uuid;
        `;
                await tx.$executeRaw `
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${platformHeldAmount.toFixed(2)}::numeric WHERE id = ${platformAccount.id}::uuid;
        `;
            }
            else {
                // AFFILIATE order: 4-way split — warehouse (wholesale) + affiliate
                // (margin) + driver/platform combined.
                const [warehouseAccount, resellerAccount] = await Promise.all([
                    tx.ledgerAccount.findFirstOrThrow({
                        where: { accountType: 'WAREHOUSE', user: { warehouses: { some: { id: order.warehouseId } } } },
                    }),
                    tx.ledgerAccount.findFirstOrThrow({
                        where: { accountType: 'RESELLER', user: { resellerStore: { id: order.resellerStoreId } } },
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
                await tx.$executeRaw `
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.wholesaleTotalJmd} WHERE id = ${warehouseAccount.id}::uuid;
        `;
                await tx.$executeRaw `
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.resellerMarginJmd} WHERE id = ${resellerAccount.id}::uuid;
        `;
                await tx.$executeRaw `
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${platformHeldAmount.toFixed(2)}::numeric WHERE id = ${platformAccount.id}::uuid;
        `;
            }
            return updatedOrder;
        });
        const room = order.shopId ? `shop_${order.shopId}` : `warehouse_${order.warehouseId}`;
        getSocketServer().to(room).emit('NEW_ORDER_TO_PACK', { orderId: order.id });
        return { order };
    }
    catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Unique constraint hit — a concurrent duplicate delivery of the same
            // webhook. Safe to swallow: the first delivery already did the work.
            return { skipped: true, reason: 'duplicate webhook delivery' };
        }
        throw err;
    }
}
//# sourceMappingURL=ledger.service.js.map