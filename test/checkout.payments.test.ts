import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, createCheckoutPayment, createShop, createUser, ensurePlatformAccount, createLedgerAccount, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { env } from '../src/env.js';

// A fake WiPay payment request endpoint: records what it's asked and answers
// like WiPay's hosted checkout. Nothing leaves this machine.
const fake = {
  up: true,
  requests: [] as any[],
  reset() {
    this.up = true;
    this.requests = [];
  },
};

function startFakeWiPay(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!fake.up) {
        res.writeHead(502).end('Bad gateway');
        return;
      }
      const body = JSON.parse(raw);
      fake.requests.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `https://jmsb.wipayfinancial.com/checkout/payment?o=${body.order_id}`, message: 'OK', transaction_id: `SB-${body.order_id}` }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ url: `http://localhost:${(server.address() as AddressInfo).port}/plugins/payments/request`, close: () => server.close() })),
  );
}

describe('paying at checkout', () => {
  let server: TestServer;
  let wipay: Awaited<ReturnType<typeof startFakeWiPay>>;
  let customer: TestUser;
  const SECRET = 'payments-webhook-secret';

  before(async () => {
    server = await startServer();
    wipay = await startFakeWiPay();
    customer = await createUser('CUSTOMER');
    await ensurePlatformAccount();
    Object.assign(env, { ENABLE_WIPAY_WEBHOOKS: true, WIPAY_PAYMENT_URL: wipay.url, WIPAY_API_KEY: 'test-wipay-key', WIPAY_ACCOUNT_NUMBER: undefined });
  });
  beforeEach(() => fake.reset());
  after(async () => {
    Object.assign(env, { ENABLE_WIPAY_WEBHOOKS: false, WIPAY_PAYMENT_URL: 'http://127.0.0.1:9/plugins/payments/request', WIPAY_API_KEY: '', WIPAY_WEBHOOK_SECRET: undefined });
    wipay.close();
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  /** A cart with two J$1,000 items from one approved shop (plus the 5% service fee), IsleDash J$300 + J$150. */
  async function checkout() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    const make = () => prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 5 } });
    const [a, b] = await Promise.all([make(), make()]);
    return call('POST', '/orders/checkout', customer, {
      items: [a, b].map((p) => ({ kind: 'STORE', storeId: shopId, masterProductId: p.id, quantity: 1 })),
      deliveryMethods: { [`shop:${shopId}`]: 'ISLEDASH' },
      deliveryAddress: '1 Customer Lane',
    });
  }

  it('starts one WiPay checkout for the whole cart', async () => {
    const res = await checkout();
    assert.equal(res.status, 201);
    const { orders, payment } = res.body;
    assert.equal(orders.length, 1);
    assert.match(payment.checkoutUrl, /^https:\/\/jmsb\.wipayfinancial\.com\/checkout\//);

    const [{ body }] = fake.requests;
    assert.equal(body.account_number, '1234567890', "WiPay's public sandbox account");
    assert.deepEqual(
      [body.country_code, body.currency, body.environment, body.fee_structure, body.method, body.origin],
      ['JM', 'JMD', 'sandbox', 'merchant_absorb', 'credit_card_co', 'IsleVendor'],
    );
    // Two decimals, as text: WiPay rejects a whole-number JSON total.
    assert.equal(body.total, '2550.00', 'two J$1,000 items, the 5% service fee and shipping — the whole cart');
    assert.match(body.order_id, /^[A-Z0-9]{1,16}$/);
    assert.equal(body.response_url, 'http://localhost/api/webhooks/wipay');
    assert.equal(JSON.parse(body.data).paymentId, payment.id);

    const row = await prisma.checkoutPayment.findUniqueOrThrow({ where: { id: payment.id } });
    assert.equal(row.wipayTransactionId, `SB-${body.order_id}`);
    assert.deepEqual(row.orderIds, [orders[0].id]);
  });

  it('keeps the order when WiPay can’t be reached, and lets the customer try again', async () => {
    fake.up = false;
    const { orders, payment } = (await checkout()).body;
    assert.equal(payment.status, 'FAILED');
    assert.match(payment.message, /Couldn’t start the card payment/);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } })).status, 'AWAITING_PAYMENT');

    fake.up = true;
    const status = await call('GET', `/payments/${payment.id}`, customer);
    assert.equal(status.body.canRetry, true);
    const retry = await call('POST', `/payments/${payment.id}/retry`, customer);
    assert.equal(retry.status, 201);
    assert.ok(retry.body.checkoutUrl);
    assert.equal((await prisma.checkoutPayment.findUniqueOrThrow({ where: { id: payment.id } })).status, 'SUPERSEDED');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orders[0].id } })).checkoutPaymentId, retry.body.id);
  });

  it('still places the order while payments are switched off', async () => {
    env.ENABLE_WIPAY_WEBHOOKS = false;
    try {
      const res = await checkout();
      assert.equal(res.status, 201);
      assert.equal(res.body.payment.status, 'NOT_STARTED');
      assert.match(res.body.payment.message, /switched off/);
      assert.equal(fake.requests.length, 0);
    } finally {
      env.ENABLE_WIPAY_WEBHOOKS = true;
    }
  });

  it('shows a payment only to the customer who made it, and stops offering a retry once paid', async () => {
    const { payment, orders } = (await checkout()).body;
    assert.equal((await call('GET', `/payments/${payment.id}`, await createUser('CUSTOMER'))).status, 404);
    assert.equal((await call('GET', `/payments/${payment.id}`)).status, 401);

    const row = await prisma.checkoutPayment.findUniqueOrThrow({ where: { id: payment.id } });
    const hash = crypto.createHash('md5').update(`${row.wipayTransactionId}${row.amountJmd.toFixed(2)}test-wipay-key`).digest('hex');
    await fetch(`${server.baseUrl}/api/webhooks/wipay?${new URLSearchParams({ status: 'success', order_id: row.reference, transaction_id: row.wipayTransactionId!, hash })}`, { redirect: 'manual' });

    const status = (await call('GET', `/payments/${payment.id}`, customer)).body;
    assert.equal(status.status, 'PAID');
    assert.equal(status.canRetry, false);
    assert.equal(status.cardFeePaidBy, 'merchant');
    assert.equal(status.orders[0].id, orders[0].id);
    assert.equal(status.orders[0].status, 'PACKING');
    assert.equal((await call('POST', `/payments/${payment.id}/retry`, customer)).status, 409);
  });

  describe("WiPay's payment webhook", () => {
    const notify = (body: object, secret = SECRET) => {
      const raw = JSON.stringify(body);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
      return fetch(`${server.baseUrl}/api/webhooks/wipay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WiPay-Webhook-Signature': `sha256=${signature}`, 'X-WiPay-Webhook-Timestamp': String(timestamp) },
        body: raw,
      });
    };

    it('is refused until a signing secret is configured', async () => {
      env.WIPAY_WEBHOOK_SECRET = undefined;
      assert.equal((await notify({ id: '1', event: 'payment.success', data: {} })).status, 503);
    });

    it('confirms a payment whose customer never came back — for the right amount only', async () => {
      env.WIPAY_WEBHOOK_SECRET = SECRET;
      const owner = await createUser('STORE');
      const shopId = await createShop(owner.id);
      await createLedgerAccount(owner.id, 'STORE');
      const order = await prisma.order.create({
        data: { customerId: customer.id, shopId, totalPaidJmd: 1000, wholesaleTotalJmd: 0, resellerMarginJmd: 950, driverFeeJmd: 0, platformCommissionJmd: 50, deliveryAddress: 'x' },
      });
      const payment = await createCheckoutPayment([order.id]);
      const event = (total: string) => ({ id: randomUUID(), event: 'payment.success', data: { transaction_id: payment.wipayTransactionId, order_id: payment.reference, total } });

      assert.equal((await notify(event('1000.00'), 'wrong-secret')).status, 400);
      assert.deepEqual(await (await notify(event('1.00'))).json(), { handled: false });
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'AWAITING_PAYMENT');

      assert.deepEqual(await (await notify(event('1000.00'))).json(), { handled: true });
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PACKING');
    });
  });
});
