import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptDriver,
  api,
  createDriver,
  createOrder,
  createShop,
  createUser,
  createWarehouse,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';

// The QR code on a shipping label: POST /dispatch/orders/:id/pickup-token
// (seller prints) and POST /dispatch/orders/:id/scan-pickup (driver scans).
describe('QR pickup claims', () => {
  let server: TestServer;
  let customer: TestUser;
  let warehouseOwner: TestUser, otherWarehouseOwner: TestUser;
  let shopOwner: TestUser;
  let warehouseId: string;

  before(async () => {
    server = await startServer();
    [customer, warehouseOwner, otherWarehouseOwner, shopOwner] = await Promise.all([
      createUser('CUSTOMER'),
      createUser('WAREHOUSE'),
      createUser('WAREHOUSE'),
      createUser('STORE'),
    ]);
    warehouseId = await createWarehouse(warehouseOwner.id);
    await createWarehouse(otherWarehouseOwner.id);
    await createShop(shopOwner.id);
  });

  after(() => server.close());

  /** An approved driver this warehouse has accepted as one of its couriers. */
  const courier = async () => {
    const driver = await createDriver();
    await acceptDriver(driver, { warehouseId });
    return driver;
  };
  const readyOrder = () => createOrder({ customerId: customer.id, warehouseId, status: 'READY_FOR_PICKUP' });
  const issue = (orderId: string, user: TestUser = warehouseOwner) =>
    api(server, `/dispatch/orders/${orderId}/pickup-token`, { method: 'POST', token: user.token });
  const scan = (orderId: string, user: TestUser, token?: string) =>
    api(server, `/dispatch/orders/${orderId}/scan-pickup`, { method: 'POST', token: user.token, body: token ? { token } : {} });
  const assignedDriver = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).driverId;

  describe('issuing a label token', () => {
    it('is limited to the seller that packs the order', async () => {
      const order = await readyOrder();
      assert.equal((await issue(order.id, warehouseOwner)).status, 201);
      assert.equal((await issue(order.id, otherWarehouseOwner)).status, 403);
      assert.equal((await issue(order.id, shopOwner)).status, 403);
      assert.equal((await issue(order.id, customer)).status, 403);
      assert.equal((await issue(order.id, await createDriver())).status, 403);
    });

    it('is refused for an order that is not being packed or awaiting pickup', async () => {
      const order = await createOrder({ customerId: customer.id, warehouseId, status: 'AWAITING_PAYMENT' });
      assert.equal((await issue(order.id)).status, 409);
    });
  });

  describe('scanning', () => {
    it('lets an approved driver with the label token claim the package', async () => {
      const driver = await courier();
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;

      const res = await scan(order.id, driver, token);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'PICKED_UP');
      assert.equal(res.body.customer.fullName, 'Test CUSTOMER');
      assert.ok(!('resellerMarginJmd' in res.body), 'driver response must not carry the money split');
      assert.equal(await assignedDriver(order.id), driver.id);
    });

    it('denies a claim with only the order id', async () => {
      const driver = await courier();
      const order = await readyOrder();
      await issue(order.id);

      assert.equal((await scan(order.id, driver)).status, 403);
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies a forged, tampered or wrong-order token', async () => {
      const driver = await courier();
      const [order, otherOrder] = await Promise.all([readyOrder(), readyOrder()]);
      const { token } = (await issue(order.id)).body as { token: string };
      const { token: otherToken } = (await issue(otherOrder.id)).body as { token: string };
      const [expiresAt, nonce, signature] = token.split('.');

      const attempts = [
        'garbage',
        `${Number(expiresAt) + 3600}.${nonce}.${signature}`,
        `${expiresAt}.${nonce}.${signature.slice(0, -2)}AA`,
        otherToken,
      ];
      for (const attempt of attempts) {
        assert.equal((await scan(order.id, driver, attempt)).status, 403, `"${attempt}" must be denied`);
      }
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies an expired token', async () => {
      const driver = await courier();
      const order = await readyOrder();

      // Issue the token as if the label had been printed 25 hours ago.
      mock.timers.enable({ apis: ['Date'], now: Date.now() - 25 * 60 * 60 * 1000 });
      const { token } = (await issue(order.id)).body;
      mock.timers.reset();

      assert.equal((await scan(order.id, driver, token)).status, 403);
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies a token that has already been used', async () => {
      const [first, second] = await Promise.all([courier(), courier()]);
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;
      assert.equal((await scan(order.id, first, token)).status, 200);

      // Even if the order somehow became claimable again, the spent token is dead.
      await prisma.order.update({ where: { id: order.id }, data: { status: 'READY_FOR_PICKUP', driverId: null } });
      assert.equal((await scan(order.id, second, token)).status, 403);
      assert.equal(await assignedDriver(order.id), null);
    });

    it('invalidates the previous label when a new one is printed', async () => {
      const driver = await courier();
      const order = await readyOrder();
      const { token: oldToken } = (await issue(order.id)).body;
      const { token: newToken } = (await issue(order.id)).body;

      assert.equal((await scan(order.id, driver, oldToken)).status, 403);
      assert.equal((await scan(order.id, driver, newToken)).status, 200);
    });

    it('denies an approved driver this business has not accepted, even with the label', async () => {
      const stranger = await createDriver();
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;

      const res = await scan(order.id, stranger, token);
      assert.equal(res.status, 403);
      assert.match(res.body.error, /accepted drivers/);
      assert.equal(await assignedDriver(order.id), null);

      // The token wasn't burned by the refused attempt.
      assert.equal((await scan(order.id, await courier(), token)).status, 200);
    });

    it('denies drivers who are not approved, and every non-driver role', async () => {
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;

      const pending = await createDriver({ isKycApproved: false, applicantStatus: 'PENDING_REVIEW' });
      const rejected = await createDriver({ isKycApproved: true, applicantStatus: 'REJECTED' });
      for (const user of [pending, rejected, customer, warehouseOwner, await createUser('ADMIN')]) {
        assert.equal((await scan(order.id, user, token)).status, 403, `${user.role} must not claim`);
      }
      assert.equal(await assignedDriver(order.id), null);
    });

    it('lets the assigned driver rescan without a token, and nobody else', async () => {
      const [driver, other] = await Promise.all([courier(), courier()]);
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;
      assert.equal((await scan(order.id, driver, token)).status, 200);

      assert.equal((await scan(order.id, driver)).status, 200);
      assert.equal((await scan(order.id, other)).status, 403);
      assert.equal(await assignedDriver(order.id), driver.id);
    });

    it('assigns exactly one driver when several scan the same label at once', async () => {
      const drivers = await Promise.all(Array.from({ length: 6 }, () => courier()));
      const order = await readyOrder();
      const { token } = (await issue(order.id)).body;

      const statuses = (await Promise.all(drivers.map((d) => scan(order.id, d, token)))).map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses.join(',')}`);

      const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { trackingEvents: true } });
      assert.equal(updated.driverId, drivers[statuses.indexOf(200)].id);
      assert.equal(updated.trackingEvents.filter((e) => e.status === 'PICKED_UP').length, 1);
    });
  });
});
