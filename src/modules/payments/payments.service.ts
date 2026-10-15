import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { toE164 } from '../../lib/payoutAccounts.js';
import { creditOrderPayment, notifySellerOfPaidOrder } from '../ledger/ledger.service.js';
import { cardPaymentsEnabled, effectiveFeeStructure, type FeeStructure } from '../../lib/platformSettings.js';

export const CARD_FEE_PAID_BY: Record<FeeStructure, 'customer' | 'merchant' | 'split'> = {
  customer_pay: 'customer',
  merchant_absorb: 'merchant',
  split: 'split',
};

// Customer payment through WiPay's hosted checkout
// (https://docs.wipayfinancial.com/payments-api):
//  1. startCheckoutPayment asks WiPay for a checkout page for the whole
//     cart's total and sends the customer there.
//  2. WiPay sends the customer back to WIPAY_RESPONSE_URL
//     (GET /api/webhooks/wipay) with the result. handleWiPayReturn checks
//     WiPay's hash — md5(transaction_id + original total + API key) — before
//     anything is marked paid, so a forged or altered return can't.
//  3. Every order in the payment is credited exactly once
//     (ledger.service.ts's creditOrderPayment).
// The browser never decides: the customer's status page reads the result
// from the server.

// WiPay's published sandbox account — never used outside sandbox.
const SANDBOX = {
  accountNumber: '1234567890',
  apiKey: '123',
  paymentUrl: 'https://jmsb.wipayfinancial.com/plugins/payments/request',
};

function wipayConfig() {
  const sandbox = env.WIPAY_ENV === 'sandbox';
  const accountNumber = env.WIPAY_ACCOUNT_NUMBER || (sandbox ? SANDBOX.accountNumber : undefined);
  const apiKey = env.WIPAY_API_KEY || (sandbox ? SANDBOX.apiKey : undefined);
  const paymentUrl = env.WIPAY_PAYMENT_URL || (sandbox ? SANDBOX.paymentUrl : undefined);
  if (!accountNumber || !apiKey || !paymentUrl) throw new HttpError(503, 'Card payments aren’t set up yet');
  return { accountNumber, apiKey, paymentUrl, environment: sandbox ? 'sandbox' : 'live' };
}

// Starting a payment needs both switches on; a payment already under way is
// still confirmed if an admin pauses card payments meanwhile (the customer
// may have paid) — see handleWiPayReturn.
async function assertPaymentsEnabled() {
  if (!(await cardPaymentsEnabled())) {
    throw new HttpError(503, 'Card payments are switched off right now — your order is saved and you can pay for it later');
  }
}

/** A short, unique reference WiPay accepts as order_id: letters and digits, 16 characters at most. */
function newReference() {
  return `IV${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 16);
}

/** Where WiPay sends the customer back. */
function responseUrl(requestOrigin: string) {
  return env.WIPAY_RESPONSE_URL ?? `${requestOrigin}/api/webhooks/wipay`;
}

/**
 * Starts paying for `orderIds` (all the customer's, all awaiting payment):
 * one CheckoutPayment for their combined total, and a WiPay checkout page to
 * send the customer to. Any earlier attempt for the same orders is
 * superseded. If WiPay can't be reached the attempt is saved as FAILED with
 * the reason, and the customer can try again — the orders aren't lost.
 */
export async function startCheckoutPayment(customerId: string, orderIds: string[], requestOrigin: string) {
  await assertPaymentsEnabled();
  const config = wipayConfig();
  const feeStructure = await effectiveFeeStructure();

  const payment = await prisma.$transaction(async (tx) => {
    const orders = await tx.order.findMany({ where: { id: { in: orderIds }, customerId, status: 'AWAITING_PAYMENT' } });
    if (orders.length === 0 || orders.length !== orderIds.length) throw new HttpError(409, 'These orders aren’t waiting for payment');

    const amount = orders.reduce((sum, o) => sum.plus(o.totalPaidJmd.toString()), new Decimal(0));
    const created = await tx.checkoutPayment.create({
      data: {
        customerId,
        reference: newReference(),
        orderIds,
        amountJmd: amount.toFixed(2),
        provider: env.PAYMENTS_PROVIDER === 'islevendor-pay' ? 'ISLEVENDOR_PAY' : 'NODE',
      },
    });
    // The orders' earlier attempts, if any, are replaced by this one.
    const previous = [...new Set(orders.map((o) => o.checkoutPaymentId).filter((id): id is string => !!id))];
    if (previous.length) {
      await tx.checkoutPayment.updateMany({ where: { id: { in: previous }, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'SUPERSEDED' } });
    }
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { checkoutPaymentId: created.id } });
    return created;
  });

  const customer = await prisma.user.findUniqueOrThrow({ where: { id: customerId }, select: { email: true, fullName: true, phoneNumber: true } });
  const phone = toE164(customer.phoneNumber);
  if (payment.provider === 'ISLEVENDOR_PAY') {
    return startWithIsleVendorPay(payment, { email: customer.email.slice(0, 50), name: customer.fullName.slice(0, 60), phone: phone ?? null }, feeStructure);
  }
  try {
    const res = await fetch(config.paymentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        account_number: config.accountNumber,
        country_code: env.WIPAY_COUNTRY_CODE,
        currency: env.WIPAY_CURRENCY,
        environment: config.environment,
        fee_structure: feeStructure,
        method: 'credit_card_co',
        order_id: payment.reference,
        origin: env.WIPAY_ORIGIN,
        response_url: responseUrl(requestOrigin),
        total: Number(payment.amountJmd.toFixed(2)),
        email: customer.email.slice(0, 50),
        name: customer.fullName.slice(0, 60),
        ...(phone ? { phone } : {}),
        data: JSON.stringify({ paymentId: payment.id }),
        version: '1.0.0',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; transaction_id?: string; message?: string };
    if (!res.ok || !body.url) throw new Error(body.message || `WiPay returned ${res.status}`);

    return prisma.checkoutPayment.update({
      where: { id: payment.id },
      data: { checkoutUrl: body.url, wipayTransactionId: body.transaction_id ?? null },
    });
  } catch (err) {
    // Nothing was charged: WiPay hadn't shown the customer a card form yet.
    return prisma.checkoutPayment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', message: `Couldn’t start the card payment: ${err instanceof Error ? err.message : String(err)}` },
    });
  }
}

type CheckoutPaymentRow = Awaited<ReturnType<typeof prisma.checkoutPayment.create>>;

/**
 * Hands the payment to the IsleVendor Pay service, which asks WiPay for the
 * checkout page and later reports the outcome to /internal/pay (see
 * reportPayOutcome). This row stays the marketplace's copy. The payment's
 * own id is the idempotency key, so a retried call can't open two checkouts.
 */
async function startWithIsleVendorPay(
  payment: CheckoutPaymentRow,
  customer: { email: string; name: string; phone: string | null },
  feeStructure: FeeStructure,
) {
  try {
    const res = await fetch(`${env.ISLEVENDOR_PAY_INTERNAL_URL}/internal/v1/payment-intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-IsleVendor-Service-Token': env.ISLEVENDOR_PAY_SERVICE_TOKEN ?? '' },
      body: JSON.stringify({
        idempotencyKey: payment.id,
        marketplacePaymentId: payment.id,
        gateway: 'WIPAY',
        customerUserId: payment.customerId,
        orderIds: payment.orderIds,
        amount: payment.amountJmd.toFixed(2),
        currency: 'JMD',
        feeStructure,
        customer: { email: customer.email, name: customer.name, ...(customer.phone ? { phone: customer.phone } : {}) },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; checkoutUrl?: string | null; message?: string | null; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error || `IsleVendor Pay returned ${res.status}`);
    if (body.status !== 'PENDING' || !body.checkoutUrl) {
      return prisma.checkoutPayment.update({
        where: { id: payment.id },
        data: { payIntentId: body.id, status: 'FAILED', message: body.message || 'Couldn’t start the card payment' },
      });
    }
    return prisma.checkoutPayment.update({ where: { id: payment.id }, data: { payIntentId: body.id, checkoutUrl: body.checkoutUrl } });
  } catch (err) {
    console.error(`[islevendor-pay] couldn't start payment ${payment.id}:`, err instanceof Error ? err.message : err);
    return prisma.checkoutPayment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', message: 'Couldn’t start the card payment — please try again' },
    });
  }
}

/**
 * IsleVendor Pay reporting a payment's verified outcome (it checked WiPay's
 * hash or signature). Safe to repeat: a success credits each order once,
 * through the same confirmPayment as Node's own WiPay payments. Answers
 * what the marketplace now records, PAID, DUPLICATE (orders already paid by
 * another attempt; refund needed) or FAILED, which IsleVendor Pay stores
 * as acknowledged.
 */
export async function reportPayOutcome(
  paymentId: string,
  outcome: { paymentIntentId: string; status: 'PAID' | 'FAILED'; amount: string; transactionId: string | null; message: string | null },
) {
  const payment = await prisma.checkoutPayment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.provider !== 'ISLEVENDOR_PAY') throw new HttpError(404, 'Payment not found');
  if (payment.payIntentId && payment.payIntentId !== outcome.paymentIntentId) throw new HttpError(409, 'A different payment intent owns this payment');
  if (!payment.payIntentId) {
    // We crashed between IsleVendor Pay answering and saving its id.
    await prisma.checkoutPayment.update({ where: { id: payment.id }, data: { payIntentId: outcome.paymentIntentId } });
  }

  if (outcome.status === 'FAILED') {
    await prisma.checkoutPayment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED', message: (outcome.message || 'The card payment didn’t go through').slice(0, 500) },
    });
    return { status: 'FAILED' as const };
  }

  if (!outcome.transactionId) throw new HttpError(400, 'A paid outcome needs the WiPay transaction');
  if (!new Decimal(outcome.amount).equals(payment.amountJmd.toString())) {
    console.error(`[islevendor-pay] outcome for ${payment.id} has amount ${outcome.amount}, expected ${payment.amountJmd.toFixed(2)} — not applied`);
    throw new HttpError(409, 'The amount doesn’t match this payment');
  }
  await confirmPayment(payment.id, outcome.transactionId, { source: 'islevendor-pay', ...outcome });
  const after = await prisma.checkoutPayment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } });
  return { status: after.status === 'DUPLICATE' ? ('DUPLICATE' as const) : ('PAID' as const) };
}

function hashMatches(transactionId: string, amount: Prisma.Decimal, receivedHash: string) {
  const apiKey = env.WIPAY_API_KEY || (env.WIPAY_ENV === 'sandbox' ? SANDBOX.apiKey : '');
  if (!apiKey || !/^[0-9a-f]{32}$/i.test(receivedHash)) return false;
  const expected = crypto.createHash('md5').update(`${transactionId}${amount.toFixed(2)}${apiKey}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedHash.toLowerCase()));
}

/**
 * The customer's return from WiPay (GET with the result in the query).
 * Returns the payment it was for (null if the reference is unknown), so the
 * caller can send the customer to its status page.
 *
 * Success is accepted only with WiPay's hash over the transaction id and the
 * total *we* asked for — so a return for a different amount, transaction or
 * payment fails verification. Then every order in the payment is credited,
 * once; a repeat of the same return changes nothing.
 */
export async function handleWiPayReturn(query: Record<string, unknown>) {
  const str = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : '');
  const reference = str('order_id');
  const transactionId = str('transaction_id');
  const payment = reference ? await prisma.checkoutPayment.findUnique({ where: { reference } }) : null;
  if (!payment) return null;

  if (str('status') !== 'success') {
    await prisma.checkoutPayment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED', message: str('message').slice(0, 500) || 'The card payment didn’t go through' },
    });
    return payment;
  }

  if (!env.ENABLE_WIPAY_WEBHOOKS) return payment;
  if (!transactionId || (payment.wipayTransactionId && payment.wipayTransactionId !== transactionId) || !hashMatches(transactionId, payment.amountJmd, str('hash'))) {
    console.error(`[wipay] rejected an unverifiable success return for payment ${payment.id}`);
    return payment;
  }

  await confirmPayment(payment.id, transactionId, query as Prisma.InputJsonObject);
  return payment;
}

/**
 * Marks a verified payment PAID and credits every order in it that's still
 * awaiting payment — each exactly once. If none were (another attempt
 * already paid them), the customer may have paid twice: the payment is
 * marked DUPLICATE for a refund.
 */
export async function confirmPayment(paymentId: string, transactionId: string, payload: Prisma.InputJsonObject) {
  const credited = await prisma.$transaction(async (tx) => {
    // One confirmation at a time per payment.
    await tx.$queryRaw`SELECT id FROM checkout_payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
    const payment = await tx.checkoutPayment.findUniqueOrThrow({ where: { id: paymentId } });
    if (payment.status === 'PAID' || payment.status === 'DUPLICATE') return [];

    const paidOrders = [];
    for (const orderId of [...payment.orderIds].sort()) {
      const result = await creditOrderPayment(tx, orderId, { transactionId, status: 'success', payload });
      if ('order' in result && result.order) paidOrders.push(result.order);
    }
    await tx.checkoutPayment.update({
      where: { id: paymentId },
      data: {
        status: paidOrders.length ? 'PAID' : 'DUPLICATE',
        wipayTransactionId: transactionId,
        paidAt: new Date(),
        message: paidOrders.length ? null : 'Paid, but these orders were already paid by another attempt — refund needed',
      },
    });
    if (!paidOrders.length) console.error(`[wipay] payment ${paymentId} (${transactionId}) paid for orders already paid — needs a refund`);
    return paidOrders;
  });
  credited.forEach(notifySellerOfPaidOrder);
  return credited;
}

/** A payment as its customer sees it on the status page. */
export async function paymentForCustomer(paymentId: string, customerId: string) {
  const payment = /^[0-9a-f-]{36}$/i.test(paymentId) ? await prisma.checkoutPayment.findUnique({ where: { id: paymentId } }) : null;
  if (!payment || payment.customerId !== customerId) throw new HttpError(404, 'Payment not found');
  const orders = await prisma.order.findMany({
    where: { id: { in: payment.orderIds } },
    select: { id: true, status: true, totalPaidJmd: true, checkoutPaymentId: true, resellerStore: { select: { storeName: true } }, shop: { select: { shopName: true } } },
  });
  const unpaid = orders.filter((o) => o.status === 'AWAITING_PAYMENT');
  return {
    id: payment.id,
    status: payment.status,
    amountJmd: payment.amountJmd,
    message: payment.message,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt,
    checkoutUrl: payment.status === 'PENDING' ? payment.checkoutUrl : null,
    // With customer_pay or split, WiPay charged a card fee on top of amountJmd.
    cardFeePaidBy: CARD_FEE_PAID_BY[await effectiveFeeStructure()],
    orders: orders.map((o) => ({ id: o.id, status: o.status, totalPaidJmd: o.totalPaidJmd, sellerName: o.resellerStore?.storeName ?? o.shop?.shopName ?? null })),
    // Trying again makes sense while some orders are still unpaid and this
    // is the attempt they're on.
    canRetry: payment.status !== 'PAID' && unpaid.length > 0 && unpaid.every((o) => o.checkoutPaymentId === payment.id),
  };
}

/** A fresh attempt for whatever in `paymentId` is still unpaid. */
export async function retryPayment(paymentId: string, customerId: string, requestOrigin: string) {
  const current = await paymentForCustomer(paymentId, customerId);
  if (!current.canRetry) throw new HttpError(409, 'There’s nothing left to pay on this payment');
  return startCheckoutPayment(
    customerId,
    current.orders.filter((o) => o.status === 'AWAITING_PAYMENT').map((o) => o.id),
    requestOrigin,
  );
}

const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * WiPay's Payments API webhook (payment.* events), if one is registered:
 * catches payments whose customer never came back to the site. Verified the
 * same way as payout notifications (HMAC-SHA256 of "<timestamp>.<raw body>"),
 * then a success is applied by its WiPay transaction id — only for an amount
 * matching what we asked for.
 */
export async function handlePaymentsWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  if (!env.WIPAY_WEBHOOK_SECRET) throw new HttpError(503, 'WiPay payment notifications are not configured');
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const signature = header('x-wipay-webhook-signature') ?? '';
  const timestamp = Number(header('x-wipay-webhook-timestamp'));
  if (!signature.startsWith('sha256=') || !Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new HttpError(400, 'Invalid or expired WiPay signature');
  }
  const expected = Buffer.from(crypto.createHmac('sha256', env.WIPAY_WEBHOOK_SECRET).update(`${timestamp}.`).update(rawBody).digest('hex'));
  const provided = Buffer.from(signature.slice('sha256='.length).toLowerCase());
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) throw new HttpError(400, 'Invalid or expired WiPay signature');

  const envelope = JSON.parse(rawBody.toString('utf8')) as { id?: string; event?: string; data?: Record<string, unknown> };
  if (envelope.event !== 'payment.success' || !envelope.data || !env.ENABLE_WIPAY_WEBHOOKS) return { handled: false };

  const transactionId = typeof envelope.data.transaction_id === 'string' ? envelope.data.transaction_id : '';
  const reference = typeof envelope.data.order_id === 'string' ? envelope.data.order_id : '';
  const payment = await prisma.checkoutPayment.findFirst({ where: { OR: [{ wipayTransactionId: transactionId || '-' }, { reference: reference || '-' }] } });
  if (!payment || !transactionId) return { handled: false };
  const total = envelope.data.total;
  if (total !== undefined && !new Decimal(String(total)).equals(payment.amountJmd.toString())) {
    console.error(`[wipay] payment.success for ${payment.id} has total ${String(total)}, expected ${payment.amountJmd.toFixed(2)} — not applied`);
    return { handled: false };
  }
  await confirmPayment(payment.id, transactionId, envelope as Prisma.InputJsonObject);
  return { handled: true };
}
