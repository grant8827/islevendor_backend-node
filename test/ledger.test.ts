import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { env } from '../src/env.js';
import {
  api,
  createDriver,
  createLedgerAccount,
  createOrder,
  createResellerStore,
  createShop,
  createUser,
  createWarehouse,
  ensurePlatformAccount,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';

const API_KEY = 'test-wipay-key';

// Fixture orders (see helpers.ts's createOrder): 900 wholesale + 200 margin
// + 300 driver fee + 100 commission = 1500 paid.
const WHOLESALE = 900;
const MARGIN = 200;
const PLATFORM_HELD = 400;
const TOTAL_PAID = 1500;

describe('ledger integrity', () => {
  let server: TestServer;
  let customer: TestUser;
  let warehouseOwner: TestUser, reseller: TestUser, shopOwner: TestUser, driver: TestUser;
  let warehouseId: string, resellerStoreId: string, shopId: string;
  let platformAccountId: string;

  before(async () => {
    server = await startServer();
    [customer, warehouseOwner, reseller, shopOwner] = await Promise.all([
      createUser('CUSTOMER'),
      createUser('WAREHOUSE'),
      createUser('RESELLER'),
      createUser('STORE'),
    ]);
    driver = await createDriver();
    warehouseId = await createWarehouse(warehouseOwner.id);
    resellerStoreId = await createResellerStore(reseller.id);
    shopId = await createShop(shopOwner.id);
    await Promise.all([
      createLedgerAccount(warehouseOwner.id, 'WAREHOUSE'),
      createLedgerAccount(reseller.id, 'RESELLER'),
      createLedgerAccount(shopOwner.id, 'STORE'),
    ]);
    platformAccountId = (await ensurePlatformAccount()).id;

    // The containment flags default to off (see SECURITY_CONTAINMENT.md);
    // these tests are the evidence for turning them on.
    Object.assign(env, {
      WIPAY_API_KEY: API_KEY,
      ENABLE_WIPAY_WEBHOOKS: true,
      ENABLE_WITHDRAWALS: true,
      ENABLE_ESCROW_RELEASE: true,
    });
  });

  // The invariant every test must leave intact, for every account in the
  // database: the cached balances equal the sum of the legs behind them, and
  // neither is negative.
  afterEach(async () => {
    const drifted = await prisma.$queryRaw<{ id: string }[]>`
      SELECT a.id
      FROM ledger_accounts a
      LEFT JOIN ledger_transactions t
        ON t.recipient_account_id = a.id AND t.reversed_at IS NULL AND t.payout_id IS NULL
      GROUP BY a.id
      HAVING a.pending_balance_jmd <> COALESCE(SUM(t.amount_jmd) FILTER (WHERE t.escrow_state = 'HELD_IN_ESCROW'), 0)
          OR a.available_balance_jmd <> COALESCE(SUM(t.amount_jmd) FILTER (WHERE t.escrow_state = 'AVAILABLE'), 0)
          OR a.pending_balance_jmd < 0
          OR a.available_balance_jmd < 0
    `;
    assert.deepEqual(drifted, [], 'account balances must reconcile to their ledger legs');
  });

  after(() => server.close());

  const affiliateOrder = () => createOrder({ customerId: customer.id, warehouseId, resellerStoreId });
  const shopOrder = () => createOrder({ customerId: customer.id, shopId });

  function callback(orderId: string, opts: { transactionId?: string; status?: string; key?: string } = {}) {
    const transaction_id = opts.transactionId ?? `txn-${randomUUID()}`;
    const hash = createHash('md5').update(`${transaction_id}${orderId}${opts.key ?? API_KEY}`).digest('hex');
    return { order_id: orderId, transaction_id, hash, status: opts.status ?? 'success' };
  }
  const postWebhook = (body: unknown) => api(server, '/ledger/webhooks/wipay', { method: 'POST', body });
  const withdraw = (user: TestUser) => api(server, '/ledger/withdraw', { method: 'POST', token: user.token });

  async function balances(user: TestUser) {
    const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: user.id } });
    return { pending: Number(account.pendingBalanceJmd), available: Number(account.availableBalanceJmd) };
  }
  const orderStatus = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const legsOf = (orderId: string) => prisma.ledgerTransaction.findMany({ where: { orderId } });

  /** Runs `fn` and returns how much each balance moved while it ran. */
  async function delta(user: TestUser, fn: () => Promise<unknown>) {
    const before_ = await balances(user);
    await fn();
    const after_ = await balances(user);
    return { pending: after_.pending - before_.pending, available: after_.available - before_.available };
  }

  /** Pays for an order and walks it to PICKED_UP by `driver`, ready to deliver. */
  async function paidAndPickedUp(orderId: string) {
    assert.equal((await postWebhook(callback(orderId))).status, 200);
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PICKED_UP', driverId: driver.id } });
  }
  const deliver = (orderId: string, user: TestUser = driver) =>
    api(server, `/dispatch/orders/${orderId}/delivered`, {
      method: 'POST',
      token: user.token,
      body: { proofOfDeliveryImageUrl: 'private-kyc://proof.jpg' },
    });

  describe('WiPay callbacks', () => {
    it('credits a paid order exactly once, with legs that add up to what was paid', async () => {
      const order = await affiliateOrder();
      const moved = await delta(warehouseOwner, async () => {
        const res = await postWebhook(callback(order.id));
        assert.equal(res.status, 200);
        assert.equal(res.body.order.status, 'PACKING');
      });
      assert.deepEqual(moved, { pending: WHOLESALE, available: 0 });

      const legs = await legsOf(order.id);
      assert.equal(legs.length, 3);
      assert.ok(legs.every((leg) => leg.escrowState === 'HELD_IN_ESCROW'));
      assert.equal(
        legs.reduce((sum, leg) => sum + Number(leg.amountJmd), 0),
        TOTAL_PAID,
      );
      assert.equal(Number(legs.find((leg) => leg.recipientAccountId === platformAccountId)!.amountJmd), PLATFORM_HELD);
    });

    it('splits a shop order between the shop and the platform', async () => {
      const order = await shopOrder();
      const moved = await delta(shopOwner, () => postWebhook(callback(order.id)));
      assert.deepEqual(moved, { pending: MARGIN, available: 0 });
      assert.equal((await legsOf(order.id)).length, 2);
    });

    it('rejects a callback with a bad signature, or when no key is configured', async () => {
      const order = await affiliateOrder();
      assert.equal((await postWebhook(callback(order.id, { key: 'wrong-key' }))).status, 400);

      env.WIPAY_API_KEY = undefined;
      try {
        assert.equal((await postWebhook(callback(order.id, { key: '' }))).status, 400);
      } finally {
        env.WIPAY_API_KEY = API_KEY;
      }

      assert.equal(await orderStatus(order.id), 'AWAITING_PAYMENT');
      assert.equal((await legsOf(order.id)).length, 0);
    });

    it('rejects a malformed payload', async () => {
      for (const body of [{}, { order_id: 'nope', transaction_id: 't', hash: 'h', status: 'success' }, { order_id: { $ne: null } }]) {
        assert.equal((await postWebhook(body)).status, 400);
      }
    });

    it('refuses everything while the containment flag is off', async () => {
      const order = await affiliateOrder();
      env.ENABLE_WIPAY_WEBHOOKS = false;
      try {
        assert.equal((await postWebhook(callback(order.id))).status, 503);
      } finally {
        env.ENABLE_WIPAY_WEBHOOKS = true;
      }
      assert.equal(await orderStatus(order.id), 'AWAITING_PAYMENT');
    });

    it('treats a redelivered callback as a no-op', async () => {
      const order = await affiliateOrder();
      const body = callback(order.id);
      await postWebhook(body);

      const moved = await delta(warehouseOwner, async () => {
        const res = await postWebhook(body);
        assert.equal(res.status, 200);
        assert.equal(res.body.skipped, true);
      });
      assert.deepEqual(moved, { pending: 0, available: 0 });
      assert.equal((await legsOf(order.id)).length, 3);
    });

    it('credits once when the same callback arrives many times at the same moment', async () => {
      const order = await affiliateOrder();
      const body = callback(order.id);

      const moved = await delta(reseller, async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => postWebhook(body)));
        assert.ok(results.every((r) => r.status === 200));
        assert.equal(results.filter((r) => r.body.order).length, 1);
      });
      assert.deepEqual(moved, { pending: MARGIN, available: 0 });
      assert.equal(await prisma.paymentEvent.count({ where: { orderId: order.id } }), 1);
    });

    it('credits once when different transactions for one order arrive at the same moment', async () => {
      const order = await affiliateOrder();

      const moved = await delta(warehouseOwner, async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => postWebhook(callback(order.id))));
        assert.ok(results.every((r) => r.status === 200));
        assert.equal(results.filter((r) => r.body.order).length, 1);
      });
      assert.deepEqual(moved, { pending: WHOLESALE, available: 0 });
      assert.equal((await legsOf(order.id)).length, 3);

      // The nine losers are on record for reconciliation — each is a
      // transaction the provider says succeeded against an already-paid order.
      const events = await prisma.paymentEvent.findMany({ where: { orderId: order.id } });
      assert.equal(events.filter((e) => e.outcome === 'APPLIED').length, 1);
      assert.equal(events.filter((e) => e.outcome === 'IGNORED_ORDER_NOT_AWAITING_PAYMENT').length, 9);
    });

    it('does not let a transaction id be replayed against a different order', async () => {
      const [paid, unpaid] = await Promise.all([affiliateOrder(), affiliateOrder()]);
      const transactionId = `txn-${randomUUID()}`;
      await postWebhook(callback(paid.id, { transactionId }));

      const res = await postWebhook(callback(unpaid.id, { transactionId }));
      assert.equal(res.body.skipped, true);
      assert.equal(await orderStatus(unpaid.id), 'AWAITING_PAYMENT');
      assert.equal((await legsOf(unpaid.id)).length, 0);
    });

    it('leaves a failed payment awaiting retry, and accepts the later success', async () => {
      const order = await affiliateOrder();
      const failed = await postWebhook(callback(order.id, { status: 'failed' }));
      assert.equal(failed.body.skipped, true);
      assert.equal(await orderStatus(order.id), 'AWAITING_PAYMENT');

      await postWebhook(callback(order.id));
      assert.equal(await orderStatus(order.id), 'PACKING');
    });

    it('does not credit an order that is no longer awaiting payment', async () => {
      const order = await createOrder({ customerId: customer.id, warehouseId, resellerStoreId, status: 'CANCELLED' });
      const moved = await delta(warehouseOwner, () => postWebhook(callback(order.id)));
      assert.deepEqual(moved, { pending: 0, available: 0 });
      assert.equal(await orderStatus(order.id), 'CANCELLED');
    });
  });

  describe('escrow release on delivery', () => {
    it('moves an order from pending to available when the assigned driver delivers it', async () => {
      const order = await affiliateOrder();
      await paidAndPickedUp(order.id);

      const moved = await delta(warehouseOwner, async () => assert.equal((await deliver(order.id)).status, 200));
      assert.deepEqual(moved, { pending: -WHOLESALE, available: WHOLESALE });
      assert.ok((await legsOf(order.id)).every((leg) => leg.escrowState === 'AVAILABLE'));
    });

    it('releases once however many times delivery is reported', async () => {
      const order = await affiliateOrder();
      await paidAndPickedUp(order.id);

      const moved = await delta(reseller, async () => {
        const statuses = (await Promise.all(Array.from({ length: 6 }, () => deliver(order.id)))).map((r) => r.status);
        assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses.join(',')}`);
        assert.equal(statuses.filter((s) => s === 409).length, 5);
        assert.equal((await deliver(order.id)).status, 409);
      });
      assert.deepEqual(moved, { pending: -MARGIN, available: MARGIN });
      assert.equal(await prisma.orderTrackingEvent.count({ where: { orderId: order.id, status: 'DELIVERED' } }), 1);
    });

    it('refuses delivery of an order that is not out for delivery', async () => {
      const order = await affiliateOrder();
      await postWebhook(callback(order.id));
      // Assigned but refunded in the meantime — must not come back as DELIVERED.
      await prisma.order.update({ where: { id: order.id }, data: { status: 'REFUNDED', driverId: driver.id } });

      const moved = await delta(warehouseOwner, async () => assert.equal((await deliver(order.id)).status, 409));
      assert.deepEqual(moved, { pending: 0, available: 0 });
      assert.equal(await orderStatus(order.id), 'REFUNDED');

      // Tidy up so the reconciliation invariant reflects a real refund.
      await prisma.order.update({ where: { id: order.id }, data: { status: 'PICKED_UP' } });
      assert.equal((await deliver(order.id)).status, 200);
    });

    it('refuses delivery by a driver who is not assigned', async () => {
      const order = await affiliateOrder();
      await paidAndPickedUp(order.id);
      assert.equal((await deliver(order.id, await createDriver())).status, 403);
      assert.equal(await orderStatus(order.id), 'PICKED_UP');
      assert.equal((await deliver(order.id)).status, 200);
    });
  });

  describe('withdrawals', () => {
    // Each test gets its own seller so balances start from zero.
    async function freshShop() {
      const owner = await createUser('STORE');
      await createLedgerAccount(owner.id, 'STORE');
      const id = await createShop(owner.id);
      return { owner, order: () => createOrder({ customerId: customer.id, shopId: id }) };
    }

    it('cannot withdraw money that is still in escrow', async () => {
      const shop = await freshShop();
      await postWebhook(callback((await shop.order()).id));
      assert.deepEqual(await balances(shop.owner), { pending: MARGIN, available: 0 });

      const res = await withdraw(shop.owner);
      assert.equal(res.status, 409);
      assert.deepEqual(await balances(shop.owner), { pending: MARGIN, available: 0 });
      assert.equal(await prisma.payout.count({ where: { ledgerAccount: { userId: shop.owner.id } } }), 0);
    });

    it('withdraws only the delivered portion and leaves the rest in escrow', async () => {
      const shop = await freshShop();
      const [delivered, inTransit] = await Promise.all([shop.order(), shop.order()]);
      await paidAndPickedUp(delivered.id);
      await paidAndPickedUp(inTransit.id);
      await deliver(delivered.id);
      assert.deepEqual(await balances(shop.owner), { pending: MARGIN, available: MARGIN });

      const res = await withdraw(shop.owner);
      assert.equal(res.status, 201);
      assert.equal(res.body.length, 1);
      assert.equal(Number(res.body[0].amountJmd), MARGIN);
      assert.equal(res.body[0].status, 'REQUESTED', 'a withdrawal is a request, not a completed payment');
      assert.deepEqual(await balances(shop.owner), { pending: MARGIN, available: 0 });

      const inTransitLeg = (await legsOf(inTransit.id)).find((leg) => leg.amountJmd.equals(MARGIN))!;
      assert.equal(inTransitLeg.payoutId, null);
      assert.equal(inTransitLeg.escrowState, 'HELD_IN_ESCROW');

      assert.equal((await withdraw(shop.owner)).status, 409, 'nothing left to withdraw');
    });

    it('pays out once when several withdrawals are requested at the same moment', async () => {
      const shop = await freshShop();
      const order = await shop.order();
      await paidAndPickedUp(order.id);
      await deliver(order.id);

      const statuses = (await Promise.all(Array.from({ length: 6 }, () => withdraw(shop.owner)))).map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses.join(',')}`);
      assert.deepEqual(await balances(shop.owner), { pending: 0, available: 0 });

      const payouts = await prisma.payout.findMany({ where: { ledgerAccount: { userId: shop.owner.id } } });
      assert.equal(payouts.length, 1);
      assert.equal(Number(payouts[0].amountJmd), MARGIN);
    });

    it('is refused while the containment flag is off', async () => {
      const shop = await freshShop();
      env.ENABLE_WITHDRAWALS = false;
      try {
        assert.equal((await withdraw(shop.owner)).status, 503);
      } finally {
        env.ENABLE_WITHDRAWALS = true;
      }
    });

    it('cannot drive a balance negative, even by writing to the database directly', async () => {
      const shop = await freshShop();
      const account = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: shop.owner.id } });
      for (const column of ['pendingBalanceJmd', 'availableBalanceJmd'] as const) {
        await assert.rejects(prisma.ledgerAccount.update({ where: { id: account.id }, data: { [column]: { decrement: 1 } } }));
      }
      assert.deepEqual(await balances(shop.owner), { pending: 0, available: 0 });
    });
  });
});
