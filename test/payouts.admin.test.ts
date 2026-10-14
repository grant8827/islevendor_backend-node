import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  acceptDriver,
  api,
  createDriver,
  createLedgerAccount,
  createShop,
  createUser,
  ensurePlatformAccount,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { env } from '../src/env.js';

// Driver earnings, IsleVendor's own withdrawals, and settling payout requests.
describe('payouts', () => {
  let server: TestServer;
  let customer: TestUser, admin: TestUser;
  let platformAccountId: string;

  before(async () => {
    server = await startServer();
    [customer, admin] = await Promise.all([createUser('CUSTOMER'), createUser('ADMIN')]);
    platformAccountId = (await ensurePlatformAccount()).id;
    await api(server, '/admin/settings/isledash', { method: 'PUT', token: admin.token, body: { baseFeeJmd: 300, extraItemPercent: 50 } });
    Object.assign(env, { WIPAY_API_KEY: 'test-wipay-key', ENABLE_WIPAY_WEBHOOKS: true, ENABLE_ESCROW_RELEASE: true, ENABLE_WITHDRAWALS: true });
  });
  after(async () => {
    Object.assign(env, { WIPAY_API_KEY: '', ENABLE_WIPAY_WEBHOOKS: false, ENABLE_ESCROW_RELEASE: false, ENABLE_WITHDRAWALS: false });
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });
  const balances = async (accountId: string) => {
    const a = await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: accountId } });
    return { pending: Number(a.pendingBalanceJmd), available: Number(a.availableBalanceJmd) };
  };

  /** A J$1,000 shop item sold with IsleDash, paid, and delivered by a driver with bank details on file. */
  async function deliveredIsleDashOrder() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    const product = await prisma.shopProduct.create({
      data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 5 },
    });
    const driver = await createDriver();
    await prisma.driverProfile.update({
      where: { userId: driver.id },
      data: { payoutMethod: 'BANK', bankName: 'NCB', accountHolderName: 'Test Driver', accountNumber: '123456789012', branchCode: '01' },
    });
    await acceptDriver(driver, { shopId });

    const [order] = (
      await call('POST', '/orders/checkout', customer, {
        items: [{ kind: 'STORE', storeId: shopId, masterProductId: product.id, quantity: 1 }],
        deliveryMethods: { [`shop:${shopId}`]: 'ISLEDASH' },
        deliveryAddress: '1 Customer Lane',
      })
    ).body;
    const transaction_id = `txn-${randomUUID()}`;
    const hash = createHash('md5').update(`${transaction_id}${order.id}test-wipay-key`).digest('hex');
    assert.equal((await call('POST', '/ledger/webhooks/wipay', undefined, { order_id: order.id, transaction_id, hash, status: 'success' })).status, 200);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PICKED_UP', driverId: driver.id } });
    return { orderId: order.id as string, driver, owner };
  }

  const deliver = (orderId: string, driver: TestUser) =>
    call('POST', `/dispatch/orders/${orderId}/delivered`, driver, { proofOfDeliveryImageUrl: 'private-kyc://proof.jpg' });

  describe('driver earnings', () => {
    it("moves the IsleDash fee to the driver's own account on delivery", async () => {
      const { orderId, driver } = await deliveredIsleDashOrder();
      const platformBefore = await balances(platformAccountId);
      assert.equal((await deliver(orderId, driver)).status, 200);

      const legs = await prisma.ledgerTransaction.findMany({ where: { orderId }, include: { recipientAccount: true } });
      const byType = Object.fromEntries(legs.map((l) => [l.recipientAccount.accountType, Number(l.amountJmd)]));
      assert.deepEqual(byType, { STORE: 1000, PLATFORM: 50, DRIVER: 300 }, 'the platform keeps only its commission');
      assert.ok(legs.every((l) => l.escrowState === 'AVAILABLE'));

      const platformAfter = await balances(platformAccountId);
      assert.equal(platformAfter.pending - platformBefore.pending, -350);
      assert.equal(platformAfter.available - platformBefore.available, 50);
      const driverAccount = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: driver.id, accountType: 'DRIVER' } });
      assert.deepEqual(await balances(driverAccount.id), { pending: 0, available: 300 });
    });
  });

  describe("IsleVendor's balance", () => {
    it('shows admins the platform balance and lets them withdraw it, audited', async () => {
      const { orderId, driver } = await deliveredIsleDashOrder();
      await deliver(orderId, driver);

      const view = await call('GET', '/admin/ledger/platform', admin);
      assert.equal(view.status, 200);
      assert.ok(Number(view.body.account.availableBalanceJmd) >= 50);
      assert.ok(view.body.entries.some((e: any) => e.orderId === orderId));

      assert.equal((await call('POST', '/admin/ledger/platform/withdraw', driver)).status, 403);
      const withdrawn = await call('POST', '/admin/ledger/platform/withdraw', admin);
      assert.equal(withdrawn.status, 201);
      assert.equal(withdrawn.body.status, 'REQUESTED');
      assert.equal((await balances(platformAccountId)).available, 0);
      assert.equal(await prisma.auditEvent.count({ where: { action: 'ledger.platform_withdrawal_requested', targetId: withdrawn.body.id } }), 1);

      assert.equal((await call('POST', '/admin/ledger/platform/withdraw', admin)).status, 409, 'nothing left');
    });
  });

  describe('payout queue', () => {
    async function driverPayout() {
      const { orderId, driver } = await deliveredIsleDashOrder();
      await deliver(orderId, driver);
      const res = await call('POST', '/ledger/withdraw', driver);
      assert.equal(res.status, 201);
      return { driver, payoutId: res.body[0].id as string };
    }

    it('lists waiting requests with where to send the money', async () => {
      const { driver, payoutId } = await driverPayout();
      const res = await call('GET', '/admin/payouts', admin);
      const row = res.body.payouts.find((p: any) => p.id === payoutId);
      assert.equal(Number(row.amountJmd), 300);
      assert.equal(row.ledgerAccount.user.id, driver.id);
      assert.deepEqual(
        [row.destination.payoutMethod, row.destination.bankName, row.destination.accountNumber],
        ['BANK', 'NCB', '123456789012'],
      );
      assert.equal((await call('GET', '/admin/payouts', driver)).status, 403);
    });

    it('marks a payout paid once, with the transfer reference', async () => {
      const { payoutId } = await driverPayout();
      assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, admin, { status: 'PAID' })).status, 400, 'reference required');
      const paid = await call('PATCH', `/admin/payouts/${payoutId}`, admin, { status: 'PAID', reference: 'NCB-TRF-0042' });
      assert.equal(paid.status, 200);
      assert.deepEqual([paid.body.status, paid.body.reference, paid.body.settledBy], ['PAID', 'NCB-TRF-0042', admin.id]);
      assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, admin, { status: 'FAILED', note: 'oops' })).status, 409);

      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'payout.paid', targetId: payoutId } });
      assert.deepEqual(event.metadata, { amountJmd: '300.00', reference: 'NCB-TRF-0042' });
    });

    it("returns a failed payout's money to the owner, who can withdraw it again", async () => {
      const { driver, payoutId } = await driverPayout();
      const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: driver.id, accountType: 'DRIVER' } });
      assert.equal((await balances(account.id)).available, 0);

      const failed = await call('PATCH', `/admin/payouts/${payoutId}`, admin, { status: 'FAILED', note: 'Account number rejected by the bank' });
      assert.equal(failed.status, 200);
      assert.equal((await balances(account.id)).available, 300);
      assert.equal(await prisma.ledgerTransaction.count({ where: { payoutId } }), 0);

      const again = await call('POST', '/ledger/withdraw', driver);
      assert.equal(again.status, 201);
      assert.equal(Number(again.body[0].amountJmd), 300);
    });

    it('is admin-only, and refuses unknown payouts', async () => {
      const { driver, payoutId } = await driverPayout();
      assert.equal((await call('PATCH', `/admin/payouts/${payoutId}`, driver, { status: 'PAID', reference: 'x' })).status, 403);
      assert.equal((await call('PATCH', `/admin/payouts/${randomUUID()}`, admin, { status: 'PAID', reference: 'x' })).status, 404);
    });
  });
});
