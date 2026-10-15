import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, createLedgerAccount, createShop, createUser, ensurePlatformAccount, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { env } from '../src/env.js';

const TOKEN = 'test-islevendor-pay-service-token-0123456789';

// A fake IsleVendor Pay (the Java service): records what it's asked and
// answers like POST /internal/v1/payment-intents.
const fake = {
  mode: 'ok' as 'ok' | 'failed' | 'down',
  requests: [] as { headers: http.IncomingHttpHeaders; body: any }[],
  reset() {
    this.mode = 'ok';
    this.requests = [];
  },
};

function startFakePay(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (fake.mode === 'down') {
        res.writeHead(503).end('{}');
        return;
      }
      const body = JSON.parse(raw);
      fake.requests.push({ headers: req.headers, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          fake.mode === 'failed'
            ? { id: randomUUID(), status: 'FAILED', checkoutUrl: null, message: 'Couldn’t start the card payment: Invalid account' }
            : { id: randomUUID(), status: 'PENDING', checkoutUrl: `https://jmsb.wipayfinancial.com/checkout/${body.idempotencyKey.slice(0, 8)}` },
        ),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

describe('payments through IsleVendor Pay', () => {
  let server: TestServer;
  let pay: Awaited<ReturnType<typeof startFakePay>>;
  let customer: TestUser;

  before(async () => {
    server = await startServer();
    pay = await startFakePay();
    customer = await createUser('CUSTOMER');
    await ensurePlatformAccount();
    Object.assign(env, { ENABLE_WIPAY_WEBHOOKS: true, PAYMENTS_PROVIDER: 'islevendor-pay', ISLEVENDOR_PAY_INTERNAL_URL: pay.url, ISLEVENDOR_PAY_SERVICE_TOKEN: TOKEN });
  });
  beforeEach(() => fake.reset());
  after(async () => {
    Object.assign(env, { ENABLE_WIPAY_WEBHOOKS: false, PAYMENTS_PROVIDER: 'node', ISLEVENDOR_PAY_INTERNAL_URL: undefined, ISLEVENDOR_PAY_SERVICE_TOKEN: undefined });
    pay.close();
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  /** Two J$1,000 items from one shop, IsleDash delivery. */
  async function checkout() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    const make = () => prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 5 } });
    const [a, b] = await Promise.all([make(), make()]);
    const res = await call('POST', '/orders/checkout', customer, {
      items: [a, b].map((p) => ({ kind: 'STORE', storeId: shopId, masterProductId: p.id, quantity: 1 })),
      deliveryMethods: { [`shop:${shopId}`]: 'ISLEDASH' },
      deliveryAddress: '1 Customer Lane',
    });
    assert.equal(res.status, 201);
    return res.body as { orders: { id: string }[]; payment: { id: string; checkoutUrl: string | null; status: string } };
  }

  /** IsleVendor Pay reporting an outcome (raw fetch: the test api() helper prefixes /api). */
  async function report(paymentId: string, body: Record<string, unknown>, token: string | null = TOKEN) {
    const res = await fetch(`${server.baseUrl}/internal/pay/payments/${paymentId}/outcome`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-IsleVendor-Service-Token': token } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  const paymentRow = (id: string) => prisma.checkoutPayment.findUniqueOrThrow({ where: { id } });

  it('hands the checkout to IsleVendor Pay and sends the customer to its WiPay page', async () => {
    const { orders, payment } = await checkout();
    assert.match(payment.checkoutUrl ?? '', /^https:\/\/jmsb\.wipayfinancial\.com\/checkout\//);

    assert.equal(fake.requests.length, 1);
    const { headers, body } = fake.requests[0];
    assert.equal(headers['x-islevendor-service-token'], TOKEN);
    assert.equal(body.idempotencyKey, payment.id);
    assert.equal(body.marketplacePaymentId, payment.id);
    assert.equal(body.gateway, 'WIPAY');
    assert.equal(body.customerUserId, customer.id);
    assert.deepEqual(body.orderIds, orders.map((o) => o.id));
    assert.equal(body.currency, 'JMD');
    assert.equal(body.customer.email.length > 0, true);

    const row = await paymentRow(payment.id);
    assert.equal(row.provider, 'ISLEVENDOR_PAY');
    assert.equal(body.amount, row.amountJmd.toFixed(2));
    assert.ok(row.payIntentId);
  });

  it('credits the orders once when IsleVendor Pay reports them paid', async () => {
    const { orders, payment } = await checkout();
    const row = await paymentRow(payment.id);
    const outcome = { paymentIntentId: row.payIntentId, status: 'PAID', amount: row.amountJmd.toFixed(2), transactionId: `SB-${randomUUID()}` };

    const first = await report(payment.id, outcome);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'PAID');
    assert.equal((await paymentRow(payment.id)).status, 'PAID');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } });
    assert.equal(order.status, 'PACKING');
    const legs = await prisma.ledgerTransaction.count({ where: { orderId: orders[0].id } });
    assert.ok(legs > 0);

    // Delivered again (IsleVendor Pay retries until acknowledged): nothing doubles.
    const again = await report(payment.id, outcome);
    assert.equal(again.body.status, 'PAID');
    assert.equal(await prisma.ledgerTransaction.count({ where: { orderId: orders[0].id } }), legs);
  });

  it('refuses reports without the service token, for another intent, or for a different amount', async () => {
    const { orders, payment } = await checkout();
    const row = await paymentRow(payment.id);
    const outcome = { paymentIntentId: row.payIntentId, status: 'PAID', amount: row.amountJmd.toFixed(2), transactionId: `SB-${randomUUID()}` };

    assert.equal((await report(payment.id, outcome, null)).status, 401);
    assert.equal((await report(payment.id, outcome, 'wrong-token-wrong-token-wrong-token-xx')).status, 401);
    assert.equal((await report(payment.id, { ...outcome, paymentIntentId: randomUUID() })).status, 409);
    assert.equal((await report(payment.id, { ...outcome, amount: '1.00' })).status, 409);
    assert.equal((await report(payment.id, { ...outcome, status: 'REFUNDED' })).status, 400);
    assert.equal((await report(randomUUID(), outcome)).status, 404);

    Object.assign(env, { ISLEVENDOR_PAY_SERVICE_TOKEN: undefined });
    assert.equal((await report(payment.id, outcome)).status, 503);
    Object.assign(env, { ISLEVENDOR_PAY_SERVICE_TOKEN: TOKEN });

    assert.equal((await paymentRow(payment.id)).status, 'PENDING');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } })).status, 'AWAITING_PAYMENT');
  });

  it('shows a declined card, and still accepts a later verified payment', async () => {
    const { payment } = await checkout();
    const row = await paymentRow(payment.id);

    const failed = await report(payment.id, { paymentIntentId: row.payIntentId, status: 'FAILED', amount: row.amountJmd.toFixed(2), message: 'Card declined' });
    assert.equal(failed.body.status, 'FAILED');
    const afterFail = await call('GET', `/payments/${payment.id}`, customer);
    assert.equal(afterFail.body.status, 'FAILED');
    assert.equal(afterFail.body.message, 'Card declined');
    assert.equal(afterFail.body.canRetry, true);

    const paid = await report(payment.id, { paymentIntentId: row.payIntentId, status: 'PAID', amount: row.amountJmd.toFixed(2), transactionId: `SB-${randomUUID()}` });
    assert.equal(paid.body.status, 'PAID');
  });

  it('marks a second payment for already-paid orders as a duplicate to refund', async () => {
    const { payment } = await checkout();
    const retry = await call('POST', `/payments/${payment.id}/retry`, customer);
    assert.equal(retry.status, 201);
    assert.equal(fake.requests.length, 2);
    assert.notEqual(fake.requests[1].body.idempotencyKey, fake.requests[0].body.idempotencyKey);

    const first = await paymentRow(retry.body.id);
    const old = await paymentRow(payment.id);
    assert.equal(old.status, 'SUPERSEDED');
    const pay = (row: typeof first) =>
      report(row.id, { paymentIntentId: row.payIntentId, status: 'PAID', amount: row.amountJmd.toFixed(2), transactionId: `SB-${randomUUID()}` });

    assert.equal((await pay(first)).body.status, 'PAID');
    // The customer had also completed the old checkout page.
    assert.equal((await pay(old)).body.status, 'DUPLICATE');
    assert.equal((await paymentRow(old.id)).status, 'DUPLICATE');
  });

  it("keeps the orders if IsleVendor Pay can't start the payment", async () => {
    fake.mode = 'failed';
    const refused = await checkout();
    assert.equal(refused.payment.status, 'FAILED');
    assert.equal(refused.payment.checkoutUrl, null);

    fake.mode = 'down';
    const down = await checkout();
    assert.equal(down.payment.status, 'FAILED');
    const row = await paymentRow(down.payment.id);
    assert.match(row.message ?? '', /try again/);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: down.orders[0].id } })).status, 'AWAITING_PAYMENT');
  });

  it('leaves Node-owned payments to Node when switched back', async () => {
    Object.assign(env, { PAYMENTS_PROVIDER: 'node' });
    try {
      const { payment } = await checkout();
      assert.equal(fake.requests.length, 0);
      const row = await paymentRow(payment.id);
      assert.equal(row.provider, 'NODE');
      // IsleVendor Pay can't report on a payment it doesn't own.
      const res = await report(payment.id, { paymentIntentId: randomUUID(), status: 'PAID', amount: row.amountJmd.toFixed(2), transactionId: 'SB-X' });
      assert.equal(res.status, 404);
    } finally {
      Object.assign(env, { PAYMENTS_PROVIDER: 'islevendor-pay' });
    }
  });
});
