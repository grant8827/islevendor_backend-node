import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createShop, createUser, prisma, startServer, type TestServer, type TestUser } from './helpers.js';

// Multi-item shipping: from one seller in one checkout, the first item pays
// the full delivery fee and each further item a percentage of it.
describe('multi-item shipping', () => {
  let server: TestServer;
  let customer: TestUser, admin: TestUser;

  before(async () => {
    server = await startServer();
    [customer, admin] = await Promise.all([createUser('CUSTOMER'), createUser('ADMIN')]);
    // Every test here assumes IsleVendor's default IsleDash rate.
    await api(server, '/admin/settings/isledash', { method: 'PUT', token: admin.token, body: { baseFeeJmd: 300, extraItemPercent: 50 } });
  });
  after(() => server.close());

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  /** An approved shop selling two J$1,000 items, its own delivery at `fee` with `extraItemPercent` for extras. */
  async function shop(fee = 400, extraItemPercent = 50, stock = 10) {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    const res = await call('PUT', `/shop/${shopId}/delivery-options`, owner, {
      offersIsleDash: true,
      offersSellerDelivery: true,
      sellerDeliveryFeeJmd: fee,
      sellerDeliveryExtraItemPercent: extraItemPercent,
      offersPickup: true,
    });
    assert.equal(res.status, 200);
    const make = () =>
      prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: stock } });
    const [a, b] = await Promise.all([make(), make()]);
    const line = (product: { id: string }, quantity = 1) => ({ kind: 'STORE', storeId: shopId, masterProductId: product.id, quantity });
    return { owner, shopId, key: `shop:${shopId}`, a, b, line };
  }

  const quote = (items: object[]) => call('POST', '/orders/quote', undefined, { items });
  const optionFee = (body: any, key: string, method: string) =>
    body.sellers.find((s: any) => s.key === key).options.find((o: any) => o.method === method).feeJmd;
  // The placed orders (checkout also reports how payment started).
  const checkout = async (body: object) => {
    const res = await call('POST', '/orders/checkout', customer, { deliveryAddress: '1 Customer Lane', ...body });
    return { ...res, body: res.status === 201 ? res.body.orders : res.body };
  };

  describe('quote', () => {
    it('charges the first item in full and each further item half, counting every unit', async () => {
      const s = await shop(400);
      // Three units from one seller: two of one product, one of another.
      const res = await quote([s.line(s.a, 2), s.line(s.b)]);
      assert.equal(res.body.sellers[0].units, 3);
      assert.equal(optionFee(res.body, s.key, 'ISLEDASH'), '600.00', '300 + 150 + 150');
      assert.equal(optionFee(res.body, s.key, 'SELLER_DELIVERY'), '800.00', '400 + 200 + 200');
      assert.equal(optionFee(res.body, s.key, 'PICKUP'), '0.00');

      assert.equal(res.body.cardFeePaidBy, 'merchant', 'merchant_absorb: the cart total is what the card is charged');
      const option = res.body.sellers[0].options.find((o: any) => o.method === 'SELLER_DELIVERY');
      assert.deepEqual([option.firstItemFeeJmd, option.extraItemFeeJmd], ['400.00', '200.00']);
    });

    it("uses each seller's own extra-item rule", async () => {
      const free = await shop(400, 0);
      const full = await shop(400, 100);
      const res = await quote([free.line(free.a, 3), full.line(full.a, 3)]);
      assert.equal(optionFee(res.body, free.key, 'SELLER_DELIVERY'), '400.00', 'extras ship free');
      assert.equal(optionFee(res.body, full.key, 'SELLER_DELIVERY'), '1200.00', 'every item full price');
    });
  });

  describe('checkout', () => {
    it('puts everything from one seller in one order, with one shipping charge', async () => {
      const s1 = await shop(400);
      const s2 = await shop(400);
      const res = await checkout({
        items: [s1.line(s1.a), s1.line(s1.b, 2), s2.line(s2.a)],
        deliveryMethods: { [s1.key]: 'ISLEDASH', [s2.key]: 'SELLER_DELIVERY' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.length, 2, 'one order per seller');
      const [first, second] = res.body;

      // Seller 1, IsleDash, three units: 300 + 150 + 150, on one order.
      assert.deepEqual(
        first.items.map((i: any) => [i.shopProductId, i.quantity]),
        [
          [s1.a.id, 1],
          [s1.b.id, 2],
        ],
      );
      assert.equal(first.quantity, 3);
      assert.equal(Number(first.driverFeeJmd), 600);
      assert.equal(Number(first.totalPaidJmd), 1050 + 2100 + 600);

      // Seller 2, its own delivery: a single item pays the full fee.
      assert.equal(second.items.length, 1);
      assert.equal(Number(second.sellerDeliveryFeeJmd), 400);
      assert.equal(Number(second.driverFeeJmd), 0);
    });

    it('places nothing if any item fails', async () => {
      const s = await shop(400, 50, 1);
      const before = await prisma.order.count({ where: { shopId: s.shopId } });
      const res = await checkout({ items: [s.line(s.a), s.line(s.b, 5)], deliveryMethods: { [s.key]: 'PICKUP' } });
      assert.equal(res.status, 409);
      assert.equal(await prisma.order.count({ where: { shopId: s.shopId } }), before);
      assert.equal((await prisma.shopProduct.findUniqueOrThrow({ where: { id: s.a.id } })).stockQuantity, 1, 'stock taken for the first item was put back');
    });

    it('needs a delivery choice for every seller, and an address unless everything is picked up', async () => {
      const s1 = await shop();
      const s2 = await shop();
      const missingChoice = await checkout({ items: [s1.line(s1.a), s2.line(s2.a)], deliveryMethods: { [s1.key]: 'PICKUP' } });
      assert.equal(missingChoice.status, 400);
      assert.match(missingChoice.body.error, /Choose how/);

      const noAddress = await call('POST', '/orders/checkout', customer, { items: [s1.line(s1.a)], deliveryMethods: { [s1.key]: 'ISLEDASH' } });
      assert.equal(noAddress.status, 400);
      const pickupOnly = await call('POST', '/orders/checkout', customer, { items: [s1.line(s1.b)], deliveryMethods: { [s1.key]: 'PICKUP' } });
      assert.equal(pickupOnly.status, 201);
    });
  });

  describe('IsleDash rate', () => {
    it('is set by an admin, audited, public to read, and used from then on', async () => {
      const s = await shop();
      assert.equal((await call('PUT', '/admin/settings/isledash', s.owner, { baseFeeJmd: 500, extraItemPercent: 20 })).status, 403);
      assert.equal((await call('PUT', '/admin/settings/isledash', admin, { baseFeeJmd: 500, extraItemPercent: 150 })).status, 400);

      try {
        assert.equal((await call('PUT', '/admin/settings/isledash', admin, { baseFeeJmd: 500, extraItemPercent: 20 })).status, 200);
        assert.deepEqual((await call('GET', '/orders/isledash-rate')).body, { baseFeeJmd: '500.00', extraItemPercent: 20 });
        assert.equal(optionFee((await quote([s.line(s.a, 3)])).body, s.key, 'ISLEDASH'), '700.00', '500 + 100 + 100');

        const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.isledash_rate_changed' }, orderBy: { createdAt: 'desc' } });
        assert.equal(event.actorId, admin.id);
        assert.deepEqual((event.metadata as any).after, { baseFeeJmd: 500, extraItemPercent: 20 });
      } finally {
        await call('PUT', '/admin/settings/isledash', admin, { baseFeeJmd: 300, extraItemPercent: 50 });
      }
    });
  });
});
