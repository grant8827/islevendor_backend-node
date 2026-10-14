import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  payOrders,
  api,
  createLedgerAccount,
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
import { env } from '../src/env.js';

// An order holds every item bought from one business in one checkout.
describe('multi-item orders', () => {
  let server: TestServer;
  let customer: TestUser, admin: TestUser;

  before(async () => {
    server = await startServer();
    [customer, admin] = await Promise.all([createUser('CUSTOMER'), createUser('ADMIN')]);
    await ensurePlatformAccount();
    await api(server, '/admin/settings/isledash', { method: 'PUT', token: admin.token, body: { baseFeeJmd: 300, extraItemPercent: 50 } });
    Object.assign(env, { WIPAY_API_KEY: 'test-wipay-key', ENABLE_WIPAY_WEBHOOKS: true });
  });
  after(async () => {
    Object.assign(env, { WIPAY_API_KEY: '', ENABLE_WIPAY_WEBHOOKS: false });
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });
  // The placed orders (checkout also reports how payment started).
  const checkout = async (body: object) => {
    const res = await call('POST', '/orders/checkout', customer, { deliveryAddress: '1 Customer Lane', ...body });
    return { ...res, body: res.status === 201 ? res.body.orders : res.body };
  };

  async function shopWithTwoItems() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    const make = (title: string) =>
      prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title, category: 'Electronics', priceJmd: 1000, stockQuantity: 10 } });
    const [kettle, toaster] = await Promise.all([make('Kettle'), make('Toaster')]);
    return { owner, shopId, key: `shop:${shopId}`, kettle, toaster, line: (p: { id: string }, quantity = 1) => ({ kind: 'STORE', storeId: shopId, masterProductId: p.id, quantity }) };
  }

  async function deliveredOrder() {
    const s = await shopWithTwoItems();
    const [order] = (await checkout({ items: [s.line(s.kettle), s.line(s.toaster)], deliveryMethods: { [s.key]: 'ISLEDASH' } })).body;
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    return { ...s, orderId: order.id as string };
  }

  it("splits a warehouse's items by reseller, sharing one shipping charge", async () => {
    const [owner, r1, r2] = await Promise.all([createUser('WAREHOUSE'), createUser('RESELLER'), createUser('RESELLER')]);
    const warehouseId = await createWarehouse(owner.id);
    const [store1, store2] = await Promise.all([createResellerStore(r1.id), createResellerStore(r2.id)]);
    const product = await prisma.masterProduct.create({
      data: { warehouseId, sku: `SKU-${randomUUID()}`, title: 'Fan', category: 'Electronics', wholesalePriceJmd: 1000, stockQuantity: 10 },
    });
    await prisma.storeListing.createMany({
      data: [
        { storeId: store1, masterProductId: product.id, retailPriceJmd: 0 },
        { storeId: store2, masterProductId: product.id, retailPriceJmd: 0 },
      ],
    });
    const line = (storeId: string) => ({ kind: 'AFFILIATE', storeId, masterProductId: product.id, quantity: 1 });

    const res = await checkout({ items: [line(store1), line(store2)], deliveryMethods: { [`warehouse:${warehouseId}`]: 'ISLEDASH' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.length, 2, 'each reseller is paid on its own order');
    assert.deepEqual(res.body.map((o: any) => o.resellerStoreId).sort(), [store1, store2].sort());
    assert.deepEqual(
      res.body.map((o: any) => Number(o.driverFeeJmd)),
      [300, 150],
      'one shipping charge for the warehouse: first item full, second half',
    );
    assert.equal(res.body[0].checkoutGroupId, res.body[1].checkoutGroupId);
  });

  it("credits the ledger with the whole order's totals", async () => {
    const s = await shopWithTwoItems();
    // The shop only offers IsleDash (the default), so its own delivery is refused.
    assert.equal((await checkout({ items: [s.line(s.kettle)], deliveryMethods: { [s.key]: 'SELLER_DELIVERY' } })).status, 400);

    const [placed] = (await checkout({ items: [s.line(s.kettle), s.line(s.toaster, 2)], deliveryMethods: { [s.key]: 'ISLEDASH' } })).body;
    await payOrders(server, [placed.id]);

    const legs = await prisma.ledgerTransaction.findMany({ where: { orderId: placed.id }, include: { recipientAccount: true } });
    const byType = Object.fromEntries(legs.map((l) => [l.recipientAccount.accountType, Number(l.amountJmd)]));
    // 3 x J$1,000 to the shop; 5% commission (150) + IsleDash 300 + 150 + 150 held by the platform.
    assert.deepEqual(byType, { STORE: 3000, PLATFORM: 150 + 600 });
    assert.equal(Number(placed.totalPaidJmd), 3000 + 150 + 600);
  });

  it("shows every item in the customer's order history, and on the seller's orders", async () => {
    const s = await shopWithTwoItems();
    const [order] = (await checkout({ items: [s.line(s.kettle), s.line(s.toaster)], deliveryMethods: { [s.key]: 'ISLEDASH' } })).body;

    const mine = (await call('GET', '/orders/mine', customer)).body.find((o: any) => o.id === order.id);
    assert.equal(mine.itemTitle, 'Kettle + 1 more');
    assert.deepEqual(
      mine.items.map((i: any) => [i.title, i.listingId, i.myRating]),
      [
        ['Kettle', s.kettle.id, null],
        ['Toaster', s.toaster.id, null],
      ],
    );

    const sellerView = (await call('GET', `/shop/${s.shopId}/orders`, s.owner)).body.find((o: any) => o.id === order.id);
    assert.deepEqual(
      sellerView.items.map((i: any) => i.title),
      ['Kettle', 'Toaster'],
    );

    const detail = await call('GET', `/orders/${order.id}`, customer);
    assert.equal(detail.body.items.length, 2);
  });

  describe('ratings', () => {
    it('rates each item in an order separately', async () => {
      const o = await deliveredOrder();
      const rate = (listingId: string | undefined, rating: number) => call('POST', '/ratings', customer, { orderId: o.orderId, listingId, rating });

      assert.equal((await rate(o.kettle.id, 5)).status, 201);
      assert.equal((await rate(o.toaster.id, 2)).status, 201);
      assert.equal((await rate(o.kettle.id, 4)).status, 201, 're-rating updates in place');

      const ratings = await prisma.productRating.findMany({ where: { orderId: o.orderId } });
      assert.deepEqual(ratings.map((r) => [r.shopProductId, r.rating]).sort(), [
        [o.kettle.id, 4],
        [o.toaster.id, 2],
      ].sort());

      const mine = await call('GET', `/ratings/mine?listingId=${o.toaster.id}`, customer);
      assert.deepEqual([mine.body.eligible, mine.body.orderId, mine.body.myRating], [true, o.orderId, 2]);
    });

    it('needs to know which item, unless the order has only one', async () => {
      const o = await deliveredOrder();
      const res = await call('POST', '/ratings', customer, { orderId: o.orderId, rating: 5 });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /which item/);
      assert.equal((await call('POST', '/ratings', customer, { orderId: o.orderId, listingId: randomUUID(), rating: 5 })).status, 409);

      const single = await shopWithTwoItems();
      const [order] = (await checkout({ items: [single.line(single.kettle)], deliveryMethods: { [single.key]: 'ISLEDASH' } })).body;
      await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
      assert.equal((await call('POST', '/ratings', customer, { orderId: order.id, rating: 5 })).status, 201);
    });
  });
});
