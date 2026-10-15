import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { api, createCheckoutPayment, createLedgerAccount, createShop, createUser, ensurePlatformAccount, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { env } from '../src/env.js';
import { refreshPaySettings, updatePaySettings } from '../src/lib/platformSettings.js';

// The Superadmin's IsleVendor Pay section (/api/admin/pay/*).
describe('IsleVendor Pay', () => {
  let server: TestServer;
  let admin: TestUser, customer: TestUser;
  const PASSWORD = 'AdminPassw0rd!';

  before(async () => {
    server = await startServer();
    [admin, customer] = await Promise.all([createUser('ADMIN'), createUser('CUSTOMER')]);
    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    await ensurePlatformAccount();
  });
  after(async () => {
    await updatePaySettings({ paymentsEnabled: true, automatedPayoutsEnabled: false, wipayFeeStructure: null, platformCommissionPercent: 5 }, admin.id);
    Object.assign(env, { ENABLE_WIPAY_WEBHOOKS: false, WIPAY_API_KEY: '', WIPAY_PAYOUT_API_URL: undefined, WIPAY_PAYOUT_API_KEY: undefined });
    await server.close();
  });

  const call = (method: string, path: string, user: TestUser = admin, body?: unknown) => api(server, path, { method, token: user.token, body });

  /** An approved shop with one J$1,000 item. */
  async function shopItem() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    const product = await prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 50 } });
    return { owner, shopId, line: { kind: 'STORE', storeId: shopId, masterProductId: product.id, quantity: 1 } };
  }

  it('is for administrators only', async () => {
    for (const path of ['/admin/pay/overview', '/admin/pay/gateways', '/admin/pay/wipay', '/admin/pay/links', '/admin/pay/transactions', '/admin/pay/commissions', '/admin/pay/earnings', '/admin/pay/refunds', '/admin/pay/reports/transactions']) {
      assert.equal((await call('GET', path, customer)).status, 403, path);
    }
  });

  it('summarises payments, balances and what needs attention', async () => {
    const res = await call('GET', '/admin/pay/overview?days=7');
    assert.equal(res.status, 200);
    assert.equal(res.body.days, 7);
    for (const key of ['payments', 'paidOrders', 'vendorBalances', 'payoutsWaiting', 'refundsNeeded', 'cardPaymentsLive']) assert.ok(key in res.body, key);
  });

  describe('gateways', () => {
    it('lets an admin pause card payments, with their password, audited', async () => {
      env.ENABLE_WIPAY_WEBHOOKS = true;
      const { line } = await shopItem();
      assert.equal((await call('PATCH', '/admin/pay/gateways', admin, { paymentsEnabled: false, currentPassword: 'wrong' })).status, 400);

      assert.equal((await call('PATCH', '/admin/pay/gateways', admin, { paymentsEnabled: false, currentPassword: PASSWORD })).status, 200);
      const gateways = (await call('GET', '/admin/pay/gateways')).body;
      assert.deepEqual([gateways[0].deployEnabled, gateways[0].adminEnabled, gateways[0].active], [true, false, false]);

      // Checkout still takes the order; it just doesn't start a payment.
      const order = await call('POST', '/orders/checkout', customer, { items: [line], deliveryMethods: { [`shop:${line.storeId}`]: 'ISLEDASH' }, deliveryAddress: '1 Lane' });
      assert.equal(order.status, 201);
      assert.equal(order.body.payment.status, 'NOT_STARTED');

      await call('PATCH', '/admin/pay/gateways', admin, { paymentsEnabled: true, currentPassword: PASSWORD });
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.gateways_changed', actorId: admin.id }, orderBy: { createdAt: 'desc' } });
      assert.equal((event.metadata as any).after.paymentsEnabled, true);
    });

    it("can't turn on what the deployment has off", async () => {
      env.ENABLE_AUTOMATED_PAYOUTS = false;
      await call('PATCH', '/admin/pay/gateways', admin, { automatedPayoutsEnabled: true, currentPassword: PASSWORD });
      const payouts = (await call('GET', '/admin/pay/gateways')).body.find((g: any) => g.id === 'wipay-payouts');
      assert.deepEqual([payouts.adminEnabled, payouts.active], [true, false]);
      await call('PATCH', '/admin/pay/gateways', admin, { automatedPayoutsEnabled: false, currentPassword: PASSWORD });
    });
  });

  describe('WiPay configuration', () => {
    it('never returns a secret, only whether it is set', async () => {
      env.WIPAY_API_KEY = 'super-secret-api-key';
      const res = await call('GET', '/admin/pay/wipay');
      assert.equal(res.status, 200);
      assert.ok(!JSON.stringify(res.body).includes('super-secret-api-key'));
      assert.equal(res.body.secrets.apiKey, true);
      assert.equal(res.body.merchantAccount, "WiPay's public sandbox account");
    });

    it('lets an admin choose who pays the card fee, and the cart follows', async () => {
      const { line } = await shopItem();
      assert.equal((await call('PATCH', '/admin/pay/wipay', admin, { feeStructure: 'customer_pay', currentPassword: PASSWORD })).body.effective, 'customer_pay');
      assert.equal((await call('POST', '/orders/quote', customer, { items: [line] })).body.cardFeePaidBy, 'customer');

      assert.equal((await call('PATCH', '/admin/pay/wipay', admin, { feeStructure: null, currentPassword: PASSWORD })).body.effective, 'merchant_absorb', 'back to the environment');
      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.card_fee_changed' }, orderBy: { createdAt: 'desc' } });
      assert.deepEqual(event.metadata, { before: 'customer_pay', after: 'merchant_absorb' });
    });

    it('tests the connection without charging anything', async () => {
      const seen: string[] = [];
      const fake = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url} key=${req.headers['x-wapi-key'] ?? ''}`);
        if (req.url?.startsWith('/wapi/withdrawals?') && req.headers['x-wapi-key'] !== 'good-key') return res.writeHead(401).end();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      });
      await new Promise<void>((resolve) => fake.listen(0, resolve));
      const base = `http://localhost:${(fake.address() as AddressInfo).port}`;
      Object.assign(env, { WIPAY_PAYOUT_API_URL: `${base}/wapi`, WIPAY_PAYOUT_API_KEY: 'bad-key' });
      try {
        const res = await call('POST', '/admin/pay/wipay/test');
        const byName = Object.fromEntries(res.body.results.map((r: any) => [r.name, r.ok]));
        assert.equal(byName['Withdrawal API reachable'], true);
        assert.equal(byName['WAPI key accepted'], false);
        assert.ok(seen.every((line) => line.startsWith('GET ')), 'only reads');
      } finally {
        fake.close();
        Object.assign(env, { WIPAY_PAYOUT_API_URL: undefined, WIPAY_PAYOUT_API_KEY: undefined });
      }
    });

    it('flags payment links that break the rules', async () => {
      const links = (await call('GET', '/admin/pay/links')).body as any[];
      const byLabel = Object.fromEntries(links.map((l) => [l.label, l]));
      // The test setup points the checkout at a local address and the return at http://localhost.
      assert.equal(byLabel['Hosted checkout (WiPay)'].status, 'warning');
      assert.ok(byLabel['Hosted checkout (WiPay)'].problems.some((p: string) => /WiPay's domain/.test(p)));
      assert.equal(byLabel['Customer return'].status, 'warning');
      assert.equal(byLabel['Payments webhook'].generated, true);
    });
  });

  describe('commissions', () => {
    it("changes IsleVendor's commission for new orders, leaving placed ones alone", async () => {
      const { line } = await shopItem();
      const placed = (await call('POST', '/orders', customer, { ...line, deliveryAddress: '1 Lane' })).body;
      assert.equal(Number(placed.platformCommissionJmd), 50);

      assert.equal((await call('PUT', '/admin/pay/commissions', admin, { percent: 60, currentPassword: PASSWORD })).status, 400, 'capped at 50%');
      assert.equal((await call('PUT', '/admin/pay/commissions', admin, { percent: 8, currentPassword: PASSWORD })).status, 200);
      assert.equal((await call('POST', '/orders/quote', customer, { items: [line] })).body.items[0].serviceFeeJmd, '80.00');
      assert.equal(Number((await prisma.order.findUniqueOrThrow({ where: { id: placed.id } })).platformCommissionJmd), 50);

      const res = await call('GET', '/admin/pay/commissions');
      assert.equal(Number(res.body.platformCommissionPercent), 8);
      assert.deepEqual(res.body.history[0].metadata, { beforePercent: 5, afterPercent: 8 });

      await call('PUT', '/admin/pay/commissions', admin, { percent: 5, currentPassword: PASSWORD });
      await refreshPaySettings();
    });
  });

  describe('money records', () => {
    it('lists transactions and finds one by reference', async () => {
      const { shopId } = await shopItem();
      const order = await prisma.order.create({
        data: { customerId: customer.id, shopId, totalPaidJmd: 1050, wholesaleTotalJmd: 0, resellerMarginJmd: 1000, driverFeeJmd: 0, platformCommissionJmd: 50, deliveryAddress: 'x' },
      });
      const payment = await createCheckoutPayment([order.id]);
      const res = await call('GET', `/admin/pay/transactions?q=${payment.reference}`);
      assert.deepEqual(res.body.payments.map((p: any) => p.id), [payment.id]);
    });

    it('lists vendor earnings without the platform account', async () => {
      const res = await call('GET', '/admin/pay/earnings');
      assert.equal(res.status, 200);
      assert.ok(res.body.accounts.every((a: any) => a.accountType !== 'PLATFORM'));
    });

    it('records a refund for a payment taken twice, once', async () => {
      const { shopId } = await shopItem();
      const order = await prisma.order.create({
        data: { customerId: customer.id, shopId, totalPaidJmd: 500, wholesaleTotalJmd: 0, resellerMarginJmd: 475, driverFeeJmd: 0, platformCommissionJmd: 25, deliveryAddress: 'x' },
      });
      const payment = await createCheckoutPayment([order.id]);
      await prisma.checkoutPayment.update({ where: { id: payment.id }, data: { status: 'DUPLICATE' } });

      assert.ok((await call('GET', '/admin/pay/refunds')).body.payments.some((p: any) => p.id === payment.id));
      assert.equal((await call('POST', `/admin/pay/refunds/${payment.id}`, admin, { reference: 'WP-RF-1', currentPassword: 'nope' })).status, 400);
      const done = await call('POST', `/admin/pay/refunds/${payment.id}`, admin, { reference: 'WP-RF-1', currentPassword: PASSWORD });
      assert.deepEqual([done.body.status, done.body.refundReference], ['REFUNDED', 'WP-RF-1']);
      assert.equal((await call('POST', `/admin/pay/refunds/${payment.id}`, admin, { reference: 'again', currentPassword: PASSWORD })).status, 409);
    });

    it('exports CSV reports, audited', async () => {
      const res = await fetch(`${server.baseUrl}/api/admin/pay/reports/transactions`, { headers: { Authorization: `Bearer ${admin.token}` } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type')!, /text\/csv/);
      assert.match(res.headers.get('content-disposition')!, /attachment; filename="islevendor-transactions-/);
      assert.ok((await res.text()).startsWith('"created_at","reference"'));
      assert.ok(await prisma.auditEvent.count({ where: { action: 'pay.report_exported', actorId: admin.id } }));
    });

    it('filters the audit log to financial actions', async () => {
      const res = await call('GET', '/admin/audit-events?category=finance');
      assert.ok(res.body.events.length > 0);
      assert.ok(res.body.events.every((e: any) => /^(payout|payout_account|ledger|payment|settings|pay)\./.test(e.action)));
    });
  });
});
