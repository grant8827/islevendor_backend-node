import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSockets,
  createDriver,
  createOrder,
  createShop,
  createUser,
  createWarehouse,
  nextEvent,
  openSocket,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { getSocketServer } from '../src/lib/socket.js';
import { offerJobToDrivers } from '../src/modules/dispatch/dispatch.gateway.js';

describe('Socket.IO authorization', () => {
  let server: TestServer;
  let customer: TestUser;
  let warehouseOwner: TestUser, warehouseStaff: TestUser, otherWarehouseOwner: TestUser;
  let shopOwner: TestUser, otherShopOwner: TestUser;
  let admin: TestUser;
  let warehouseId: string;
  let shopId: string;

  before(async () => {
    server = await startServer();
    [customer, warehouseOwner, warehouseStaff, otherWarehouseOwner, shopOwner, otherShopOwner, admin] = await Promise.all([
      createUser('CUSTOMER'),
      createUser('WAREHOUSE'),
      createUser('WAREHOUSE'),
      createUser('WAREHOUSE'),
      createUser('STORE'),
      createUser('STORE'),
      createUser('ADMIN'),
    ]);
    warehouseId = await createWarehouse(warehouseOwner.id);
    await prisma.warehouseMember.create({ data: { warehouseId, userId: warehouseStaff.id, role: 'STAFF' } });
    shopId = await createShop(shopOwner.id);
  });

  afterEach(closeSockets);
  after(() => server.close());

  const readyOrder = () => createOrder({ customerId: customer.id, warehouseId, status: 'READY_FOR_PICKUP' });
  const offer = (orderId: string, drivers: TestUser[]) =>
    offerJobToDrivers(
      getSocketServer(),
      orderId,
      drivers.map((d) => d.id),
    );

  async function join(user: TestUser, event: 'warehouse:join' | 'shop:join', id: unknown): Promise<boolean> {
    const socket = await openSocket(server, user.token);
    const { ok } = await socket.timeout(3000).emitWithAck(event, id);
    return ok;
  }

  describe('seller rooms', () => {
    it('lets a warehouse owner, its staff and an admin join the warehouse room', async () => {
      for (const user of [warehouseOwner, warehouseStaff, admin]) {
        assert.equal(await join(user, 'warehouse:join', warehouseId), true);
      }
    });

    it('denies every other account, including another warehouse', async () => {
      for (const user of [otherWarehouseOwner, shopOwner, customer, await createDriver()]) {
        assert.equal(await join(user, 'warehouse:join', warehouseId), false, `${user.role} must not join`);
      }
    });

    it('lets only the shop owner and an admin join the shop room', async () => {
      assert.equal(await join(shopOwner, 'shop:join', shopId), true);
      assert.equal(await join(admin, 'shop:join', shopId), true);
      for (const user of [otherShopOwner, warehouseOwner, customer]) {
        assert.equal(await join(user, 'shop:join', shopId), false, `${user.role} must not join`);
      }
    });

    it('denies a malformed room id instead of throwing', async () => {
      assert.equal(await join(warehouseOwner, 'warehouse:join', { $ne: null }), false);
      assert.equal(await join(shopOwner, 'shop:join', 'x'), false);
    });

    it('does not deliver room events to a denied socket', async () => {
      const intruder = await openSocket(server, otherWarehouseOwner.token);
      await intruder.timeout(3000).emitWithAck('warehouse:join', warehouseId);
      const member = await openSocket(server, warehouseOwner.token);
      await member.timeout(3000).emitWithAck('warehouse:join', warehouseId);

      let leaked = false;
      intruder.on('ORDER_DELIVERED', () => (leaked = true));
      const received = nextEvent(member, ['ORDER_DELIVERED']);
      getSocketServer().to(`warehouse_${warehouseId}`).emit('ORDER_DELIVERED', { orderId: 'x' });
      await received;
      assert.equal(leaked, false);
    });
  });

  describe('driver:acceptJob', () => {
    async function accept(user: TestUser, orderId: string) {
      const socket = await openSocket(server, user.token);
      const result = nextEvent(socket, ['JOB_ASSIGNED', 'JOB_OFFER_EXPIRED']);
      socket.emit('driver:acceptJob', { orderId });
      return (await result).event;
    }
    const assignedDriver = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).driverId;

    it('lets an approved driver who was offered the job accept it, once', async () => {
      const driver = await createDriver();
      const order = await readyOrder();
      await offer(order.id, [driver]);

      assert.equal(await accept(driver, order.id), 'JOB_ASSIGNED');
      const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { trackingEvents: true } });
      assert.equal(updated.driverId, driver.id);
      assert.equal(updated.status, 'PICKED_UP');
      assert.equal(updated.trackingEvents.filter((e) => e.status === 'PICKED_UP').length, 1);

      assert.equal(await accept(driver, order.id), 'JOB_OFFER_EXPIRED');
    });

    it('denies every non-driver role, even with the order id in hand', async () => {
      const order = await readyOrder();
      for (const user of [customer, warehouseOwner, shopOwner, admin, await createUser('RESELLER')]) {
        assert.equal(await accept(user, order.id), 'JOB_OFFER_EXPIRED', `${user.role} must not claim`);
      }
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies an approved driver the job was never offered to', async () => {
      const offered = await createDriver();
      const notOffered = await createDriver();
      const order = await readyOrder();
      await offer(order.id, [offered]);

      assert.equal(await accept(notOffered, order.id), 'JOB_OFFER_EXPIRED');
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies a driver who is not KYC-approved, or was rejected, even if offered', async () => {
      const pending = await createDriver({ isKycApproved: false, applicantStatus: 'PENDING_REVIEW' });
      const rejected = await createDriver({ isKycApproved: true, applicantStatus: 'REJECTED' });
      const order = await readyOrder();
      await offer(order.id, [pending, rejected]);

      assert.equal(await accept(pending, order.id), 'JOB_OFFER_EXPIRED');
      assert.equal(await accept(rejected, order.id), 'JOB_OFFER_EXPIRED');
      assert.equal(await assignedDriver(order.id), null);
    });

    it('denies a claim on an order that is not ready for pickup', async () => {
      const driver = await createDriver();
      const order = await createOrder({ customerId: customer.id, warehouseId, status: 'AWAITING_PAYMENT' });
      await offer(order.id, [driver]);

      assert.equal(await accept(driver, order.id), 'JOB_OFFER_EXPIRED');
      assert.equal(await assignedDriver(order.id), null);
    });

    it('assigns exactly one driver when several accept at the same moment', async () => {
      const drivers = await Promise.all(Array.from({ length: 6 }, () => createDriver()));
      const order = await readyOrder();
      await offer(order.id, drivers);

      const outcomes = await Promise.all(drivers.map((d) => accept(d, order.id)));
      assert.equal(outcomes.filter((o) => o === 'JOB_ASSIGNED').length, 1);

      const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { trackingEvents: true } });
      assert.equal(updated.driverId, drivers[outcomes.indexOf('JOB_ASSIGNED')].id);
      assert.equal(updated.trackingEvents.filter((e) => e.status === 'PICKED_UP').length, 1);
    });
  });
});
