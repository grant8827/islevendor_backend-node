import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  acceptDriver,
  api,
  closeSockets,
  createDriver,
  createLedgerAccount,
  createResellerStore,
  createShop,
  createUser,
  createWarehouse,
  ensurePlatformAccount,
  nextEvent,
  openSocket,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { env } from '../src/env.js';
import { getSocketServer } from '../src/lib/socket.js';
import { offerJobToDrivers } from '../src/modules/dispatch/dispatch.gateway.js';

const ISLEDASH_FEE = 300;

describe('delivery options', () => {
  let server: TestServer;
  let customer: TestUser;

  before(async () => {
    server = await startServer();
    customer = await createUser('CUSTOMER');
    await ensurePlatformAccount();
    Object.assign(env, { WIPAY_API_KEY: 'test-wipay-key', ENABLE_WIPAY_WEBHOOKS: true, ENABLE_ESCROW_RELEASE: true });
  });
  after(async () => {
    closeSockets();
    Object.assign(env, { WIPAY_API_KEY: '', ENABLE_WIPAY_WEBHOOKS: false, ENABLE_ESCROW_RELEASE: false });
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });
  const settings = (overrides: object = {}) => ({
    offersIsleDash: true,
    offersSellerDelivery: true,
    sellerDeliveryFeeJmd: 450,
    sellerDeliveryNote: 'Kingston & St. Andrew, same day',
    offersPickup: true,
    pickupInstructions: 'Mon–Sat 9–5, ask at the front desk',
    ...overrides,
  });

  /** An approved shop selling one J$1,000 item, with every delivery option on. */
  async function shopSelling(options: object = {}) {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    await createLedgerAccount(owner.id, 'STORE');
    assert.equal((await call('PUT', `/shop/${shopId}/delivery-options`, owner, settings(options))).status, 200);
    const product = await prisma.shopProduct.create({
      data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 10 },
    });
    return { owner, shopId, product, line: { kind: 'STORE', storeId: shopId, masterProductId: product.id, quantity: 1 } };
  }

  const checkout = (body: object) => call('POST', '/orders', customer, body);
  const pay = (orderId: string) => {
    const transaction_id = `txn-${randomUUID()}`;
    const hash = createHash('md5').update(`${transaction_id}${orderId}test-wipay-key`).digest('hex');
    return call('POST', '/ledger/webhooks/wipay', undefined, { order_id: orderId, transaction_id, hash, status: 'success' });
  };

  describe('seller settings', () => {
    it('lets the owner choose what to offer, and validates it', async () => {
      const owner = await createUser('STORE');
      const shopId = await createShop(owner.id);
      const put = (body: object, user = owner) => call('PUT', `/shop/${shopId}/delivery-options`, user, body);

      assert.equal((await put(settings({ offersIsleDash: false, offersSellerDelivery: false, offersPickup: false }))).status, 400);
      const noFee = await put(settings({ sellerDeliveryFeeJmd: null }));
      assert.equal(noFee.status, 400);
      assert.match(noFee.body.error, /fee/);
      assert.equal((await put(settings(), await createUser('STORE'))).status, 403);

      const saved = await put(settings({ offersIsleDash: false }));
      assert.equal(saved.status, 200);
      assert.deepEqual(
        [saved.body.offersIsleDash, saved.body.offersSellerDelivery, Number(saved.body.sellerDeliveryFeeJmd), saved.body.offersPickup],
        [false, true, 450, true],
      );
    });

    it('is a warehouse owner or admin decision, not staff', async () => {
      const owner = await createUser('WAREHOUSE');
      const staff = await createUser('WAREHOUSE');
      const warehouseId = await createWarehouse(owner.id);
      await prisma.warehouseMember.create({ data: { warehouseId, userId: staff.id, role: 'STAFF' } });

      assert.equal((await call('PUT', `/warehouse/${warehouseId}/delivery-options`, staff, settings())).status, 403);
      assert.equal((await call('PUT', `/warehouse/${warehouseId}/delivery-options`, owner, settings())).status, 200);
    });
  });

  describe('cart quote', () => {
    it("shows each seller's options, priced by the server", async () => {
      const shop = await shopSelling({ offersIsleDash: false });
      const res = await call('POST', '/orders/quote', undefined, { items: [{ ...shop.line, quantity: 2 }] });
      assert.equal(res.status, 200);

      const [line] = res.body.items;
      assert.equal(line.available, true);
      assert.equal(line.goodsTotalJmd, '2100.00', '2 x J$1,000 plus the 5% service fee');
      assert.equal(line.serviceFeeJmd, '100.00');

      const seller = res.body.sellers.find((s: any) => s.key === line.sellerKey);
      assert.deepEqual(
        seller.options.map((o: any) => [o.method, o.feeJmd, o.needsAddress]),
        [
          ['SELLER_DELIVERY', '450.00', true],
          ['PICKUP', '0.00', false],
        ],
      );
      assert.match(seller.options[1].detail, /2 Test Road, Kingston — Mon–Sat/);
    });

    it("uses the warehouse's options for a reseller's item", async () => {
      const [owner, reseller] = await Promise.all([createUser('WAREHOUSE'), createUser('RESELLER')]);
      const warehouseId = await createWarehouse(owner.id);
      await call('PUT', `/warehouse/${warehouseId}/delivery-options`, owner, settings({ offersSellerDelivery: false }));
      const storeId = await createResellerStore(reseller.id);
      const product = await prisma.masterProduct.create({
        data: { warehouseId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', wholesalePriceJmd: 1000, stockQuantity: 3 },
      });
      await prisma.storeListing.create({ data: { storeId, masterProductId: product.id, retailPriceJmd: 0 } });

      const res = await call('POST', '/orders/quote', undefined, { items: [{ kind: 'AFFILIATE', storeId, masterProductId: product.id, quantity: 1 }] });
      assert.equal(res.body.items[0].sellerKey, `warehouse:${warehouseId}`);
      assert.deepEqual(res.body.sellers[0].options.map((o: any) => o.method), ['ISLEDASH', 'PICKUP']);
    });

    it('flags items that are gone or short on stock', async () => {
      const shop = await shopSelling();
      const res = await call('POST', '/orders/quote', undefined, {
        items: [
          { ...shop.line, quantity: 11 },
          { ...shop.line, masterProductId: randomUUID() },
        ],
      });
      assert.deepEqual(
        res.body.items.map((i: any) => [i.available, i.reason]),
        [
          [false, 'Only 10 left'],
          [false, 'No longer available'],
        ],
      );
    });
  });

  describe('checkout', () => {
    it('charges the IsleDash fee by default, as before', async () => {
      const shop = await shopSelling();
      const res = await checkout({ ...shop.line, deliveryAddress: '1 Customer Lane' });
      assert.equal(res.status, 201);
      assert.equal(res.body.deliveryMethod, 'ISLEDASH');
      assert.equal(Number(res.body.driverFeeJmd), ISLEDASH_FEE);
      assert.equal(Number(res.body.totalPaidJmd), 1050 + ISLEDASH_FEE);
    });

    it("charges the seller's own fee for seller delivery", async () => {
      const shop = await shopSelling();
      const res = await checkout({ ...shop.line, deliveryMethod: 'SELLER_DELIVERY', deliveryAddress: '1 Customer Lane' });
      assert.equal(res.status, 201);
      assert.equal(Number(res.body.sellerDeliveryFeeJmd), 450);
      assert.equal(Number(res.body.driverFeeJmd), 0);
      assert.equal(Number(res.body.totalPaidJmd), 1050 + 450);
    });

    it('makes pickup free, needs no address, and records where to collect', async () => {
      const shop = await shopSelling();
      const res = await checkout({ ...shop.line, deliveryMethod: 'PICKUP' });
      assert.equal(res.status, 201);
      assert.equal(Number(res.body.totalPaidJmd), 1050);
      assert.equal(res.body.deliveryAddress, 'Customer pickup: 2 Test Road, Kingston');
    });

    it('refuses an option the seller does not offer, or delivery with no address', async () => {
      const shop = await shopSelling({ offersPickup: false });
      const res = await checkout({ ...shop.line, deliveryMethod: 'PICKUP' });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /doesn't offer/);
      assert.equal((await checkout({ ...shop.line, deliveryMethod: 'SELLER_DELIVERY' })).status, 400);
      assert.equal((await prisma.shopProduct.findUniqueOrThrow({ where: { id: shop.product.id } })).stockQuantity, 10, 'no stock taken');
    });
  });

  describe('paying', () => {
    it("pays the seller's delivery fee to the seller, and holds only the commission for the platform", async () => {
      const shop = await shopSelling();
      const order = (await checkout({ ...shop.line, deliveryMethod: 'SELLER_DELIVERY', deliveryAddress: '1 Customer Lane' })).body;
      assert.equal((await pay(order.id)).status, 200);

      const legs = await prisma.ledgerTransaction.findMany({ where: { orderId: order.id }, include: { recipientAccount: true } });
      const byType = Object.fromEntries(legs.map((l) => [l.recipientAccount.accountType, Number(l.amountJmd)]));
      assert.deepEqual(byType, { STORE: 1000 + 450, PLATFORM: 50 });
      assert.equal(
        legs.reduce((sum, l) => sum + Number(l.amountJmd), 0),
        Number(order.totalPaidJmd),
      );
    });
  });

  describe('fulfilment', () => {
    async function paidOrder(method: 'PICKUP' | 'SELLER_DELIVERY' | 'ISLEDASH') {
      const shop = await shopSelling();
      const order = (await checkout({ ...shop.line, deliveryMethod: method, deliveryAddress: '1 Customer Lane' })).body;
      await pay(order.id);
      return { shop, orderId: order.id as string };
    }
    const ready = (orderId: string, user: TestUser) => call('POST', `/dispatch/orders/${orderId}/ready`, user);
    const complete = (orderId: string, user: TestUser) => call('POST', `/dispatch/orders/${orderId}/complete`, user, { note: 'Signed for by Andrea' });
    const status = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

    it('does not send a pickup order to drivers, and gives it no driver pickup code', async () => {
      const { shop, orderId } = await paidOrder('PICKUP');
      const driver = await createDriver();
      await acceptDriver(driver, { shopId: shop.shopId });
      await prisma.$executeRaw`UPDATE driver_profiles SET is_online = TRUE, current_location = ST_SetSRID(ST_MakePoint(-76.79, 18.01), 4326) WHERE user_id = ${driver.id}::uuid`;

      const res = await ready(orderId, shop.owner);
      assert.equal(res.status, 200);
      assert.equal(res.body.dispatched, false);
      assert.equal(res.body.reason, 'Ready for the customer to collect');
      assert.equal((await call('POST', `/dispatch/orders/${orderId}/pickup-token`, shop.owner)).status, 409);

      // Even a driver who somehow had the order id can't take it.
      await offerJobToDrivers(getSocketServer(), orderId, [driver.id]);
      const socket = await openSocket(server, driver.token);
      const outcome = nextEvent(socket, ['JOB_ASSIGNED', 'JOB_OFFER_EXPIRED']);
      socket.emit('driver:acceptJob', { orderId });
      assert.equal((await outcome).event, 'JOB_OFFER_EXPIRED');
      assert.equal(await status(orderId), 'READY_FOR_PICKUP');
    });

    it('lets the seller complete a pickup once, releasing escrow', async () => {
      const { shop, orderId } = await paidOrder('PICKUP');
      assert.equal((await complete(orderId, shop.owner)).status, 409, 'not ready yet');
      await ready(orderId, shop.owner);
      assert.equal((await ready(orderId, shop.owner)).status, 409, 'already ready');

      assert.equal((await complete(orderId, await createUser('STORE'))).status, 403);
      const res = await complete(orderId, shop.owner);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'DELIVERED');
      assert.equal((await complete(orderId, shop.owner)).status, 409);

      const legs = await prisma.ledgerTransaction.findMany({ where: { orderId } });
      assert.ok(legs.length > 0 && legs.every((l) => l.escrowState === 'AVAILABLE'));
      const event = await prisma.orderTrackingEvent.findFirstOrThrow({ where: { orderId, status: 'DELIVERED' } });
      assert.equal(event.note, 'Collected by the customer — Signed for by Andrea');
    });

    it("completes the seller's own delivery the same way", async () => {
      const { shop, orderId } = await paidOrder('SELLER_DELIVERY');
      await ready(orderId, shop.owner);
      assert.equal((await complete(orderId, shop.owner)).status, 200);
      assert.equal(await status(orderId), 'DELIVERED');
    });

    it('leaves IsleDash orders to the driver', async () => {
      const { shop, orderId } = await paidOrder('ISLEDASH');
      await ready(orderId, shop.owner);
      const res = await complete(orderId, shop.owner);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /driver/);
    });
  });
});
