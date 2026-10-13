import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  api,
  createDriver,
  createOrder,
  createResellerStore,
  createShop,
  createUser,
  createWarehouse,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';

// GET /api/orders/:id — who may read an order, and how much of it.
describe('order detail authorization', () => {
  let server: TestServer;
  let customer: TestUser, otherCustomer: TestUser;
  let warehouseOwner: TestUser, warehouseStaff: TestUser, otherWarehouseOwner: TestUser;
  let reseller: TestUser, otherReseller: TestUser;
  let shopOwner: TestUser, otherShopOwner: TestUser;
  let driver: TestUser, otherDriver: TestUser;
  let admin: TestUser;
  let affiliateOrderId: string;
  let shopOrderId: string;

  before(async () => {
    server = await startServer();
    [customer, otherCustomer, warehouseOwner, warehouseStaff, otherWarehouseOwner, reseller, otherReseller, shopOwner, otherShopOwner, admin] =
      await Promise.all([
        createUser('CUSTOMER'),
        createUser('CUSTOMER'),
        createUser('WAREHOUSE'),
        createUser('WAREHOUSE'),
        createUser('WAREHOUSE'),
        createUser('RESELLER'),
        createUser('RESELLER'),
        createUser('STORE'),
        createUser('STORE'),
        createUser('ADMIN'),
      ]);
    [driver, otherDriver] = await Promise.all([createDriver(), createDriver()]);

    const warehouseId = await createWarehouse(warehouseOwner.id);
    await createWarehouse(otherWarehouseOwner.id);
    await prisma.warehouseMember.create({ data: { warehouseId, userId: warehouseStaff.id, role: 'STAFF' } });
    const resellerStoreId = await createResellerStore(reseller.id);
    await createResellerStore(otherReseller.id);
    const shopId = await createShop(shopOwner.id);
    await createShop(otherShopOwner.id);

    affiliateOrderId = (
      await createOrder({ customerId: customer.id, warehouseId, resellerStoreId, driverId: driver.id, status: 'PICKED_UP' })
    ).id;
    shopOrderId = (await createOrder({ customerId: customer.id, shopId, status: 'PACKING' })).id;
  });

  after(() => server.close());

  const get = (orderId: string, user?: TestUser) => api(server, `/orders/${orderId}`, { token: user?.token });

  it('rejects an unauthenticated request', async () => {
    assert.equal((await get(affiliateOrderId)).status, 401);
  });

  it('hides an order from everyone who is not a participant', async () => {
    const outsiders = { otherCustomer, otherWarehouseOwner, otherReseller, otherShopOwner, shopOwner, otherDriver };
    for (const [name, user] of Object.entries(outsiders)) {
      const res = await get(affiliateOrderId, user);
      assert.equal(res.status, 404, `${name} should not see the affiliate order`);
      assert.deepEqual(res.body, { error: 'Order not found' });
    }
    for (const [name, user] of Object.entries({ otherCustomer, otherShopOwner, warehouseOwner, reseller, driver })) {
      assert.equal((await get(shopOrderId, user)).status, 404, `${name} should not see the shop order`);
    }
  });

  it('answers a missing or malformed id the same way as a forbidden one', async () => {
    assert.equal((await get(randomUUID(), otherCustomer)).status, 404);
    assert.equal((await get('not-a-uuid', otherCustomer)).status, 404);
  });

  it('shows a customer their own order without the seller/platform split', async () => {
    const res = await get(affiliateOrderId, customer);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, affiliateOrderId);
    assert.equal(res.body.totalPaidJmd, '1500');
    for (const field of ['wholesaleTotalJmd', 'resellerMarginJmd', 'platformCommissionJmd', 'customerId', 'wipayTransactionId']) {
      assert.ok(!(field in res.body), `customer view must not include ${field}`);
    }
  });

  it('shows the assigned driver the delivery details and only their own fee', async () => {
    const res = await get(affiliateOrderId, driver);
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryAddress, '12 Test Lane, Kingston');
    assert.equal(res.body.driverFeeJmd, '300');
    for (const field of ['totalPaidJmd', 'wholesaleTotalJmd', 'resellerMarginJmd', 'platformCommissionJmd']) {
      assert.ok(!(field in res.body), `driver view must not include ${field}`);
    }
  });

  it('shows the warehouse owner and its staff the wholesale leg only', async () => {
    for (const user of [warehouseOwner, warehouseStaff]) {
      const res = await get(affiliateOrderId, user);
      assert.equal(res.status, 200);
      assert.equal(res.body.wholesaleTotalJmd, '900');
      assert.ok(!('resellerMarginJmd' in res.body));
      assert.ok(!('platformCommissionJmd' in res.body));
    }
  });

  it('shows the reseller their margin but not the wholesale cost', async () => {
    const res = await get(affiliateOrderId, reseller);
    assert.equal(res.status, 200);
    assert.equal(res.body.resellerMarginJmd, '200');
    assert.ok(!('wholesaleTotalJmd' in res.body));
  });

  it('shows a shop owner their own order', async () => {
    const res = await get(shopOrderId, shopOwner);
    assert.equal(res.status, 200);
    assert.equal(res.body.shopId !== undefined, true);
  });

  it('shows an admin the full order', async () => {
    const res = await get(affiliateOrderId, admin);
    assert.equal(res.status, 200);
    assert.equal(res.body.customerId, customer.id);
    assert.equal(res.body.platformCommissionJmd, '100');
  });
});
