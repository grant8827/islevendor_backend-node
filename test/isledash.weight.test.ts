import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { api, createShop, createUser, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { isleDashQuote, weightFee, type IsleDashPricing } from '../src/lib/isleDashPricing.js';

const pricing: IsleDashPricing = {
  baseFeeJmd: new Decimal(300),
  includedMiles: new Decimal(0),
  perMileJmd: new Decimal(0),
  minFeeJmd: new Decimal(0),
  maxFeeJmd: new Decimal(500),
  maxMiles: null,
  extraItemPercent: 50,
  fallbackFeeJmd: new Decimal(300),
  roadAdjustPercent: 30,
  includedWeightLb: new Decimal(10),
  perPoundJmd: new Decimal(50),
  maxWeightLb: new Decimal(100),
};
const lb = (n: number) => new Decimal(n);

describe('IsleDash weight pricing (math)', () => {
  it('charges per pound over the included weight', () => {
    assert.equal(weightFee(pricing, lb(8)).toString(), '0');
    assert.equal(weightFee(pricing, lb(14)).toString(), '200', '4 × 50');
    assert.equal(weightFee(pricing, lb(14.5)).toString(), '225');
  });

  it('adds the weight fee after the max-fee cap, and replaces the extra-item charge', () => {
    const q = isleDashQuote(pricing, null, null, lb(30));
    assert.ok(q.available);
    assert.equal(q.rate.baseFeeJmd.toString(), '1300', '300 fallback + 20 × 50, not capped at 500');
    assert.equal(q.rate.extraItemPercent, 0);
    assert.equal(q.weightFeeJmd.toString(), '1000');
  });

  it('keeps the extra-item charge while per pound is 0', () => {
    const q = isleDashQuote({ ...pricing, perPoundJmd: new Decimal(0) }, null, null, lb(30));
    assert.ok(q.available);
    assert.equal(q.rate.baseFeeJmd.toString(), '300');
    assert.equal(q.rate.extraItemPercent, 50);
  });

  it('refuses over the max weight', () => {
    const q = isleDashQuote(pricing, null, null, lb(120));
    assert.equal(q.available, false);
    assert.match(!q.available ? q.reason : '', /Too heavy.*120 lb.*100 lb/);
    assert.ok(isleDashQuote({ ...pricing, maxWeightLb: null }, null, null, lb(120)).available);
  });
});

describe('IsleDash weight pricing (API)', () => {
  let server: TestServer;
  let customer: TestUser, admin: TestUser;
  const OFF = { includedWeightLb: 0, perPoundJmd: 0, maxWeightLb: null };

  before(async () => {
    server = await startServer();
    [customer, admin] = await Promise.all([createUser('CUSTOMER'), createUser('ADMIN')]);
    const res = await call('PUT', '/admin/settings/isledash', admin, { includedWeightLb: 10, perPoundJmd: 50, maxWeightLb: 100 });
    assert.equal(res.status, 200);
    assert.equal(res.body.perPoundJmd, '50.00');
    assert.equal(res.body.maxWeightLb, 100);
  });
  after(async () => {
    await call('PUT', '/admin/settings/isledash', admin, OFF);
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  async function shopWith(weights: (number | null)[]) {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    assert.equal((await call('PUT', `/shop/${shopId}/delivery-options`, owner, { offersIsleDash: true, offersSellerDelivery: false, offersPickup: true })).status, 200);
    const products = [];
    for (const w of weights) {
      products.push(
        await prisma.shopProduct.create({
          data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 10, weightLb: w },
        }),
      );
    }
    return { owner, shopId, key: `shop:${shopId}`, line: (i: number, quantity = 1) => ({ kind: 'STORE', storeId: shopId, masterProductId: products[i].id, quantity }) };
  }

  const quote = (items: object[]) => call('POST', '/orders/quote', undefined, { items });
  const isleDashOption = (body: any, key: string) => body.sellers.find((s: any) => s.key === key).options.find((o: any) => o.method === 'ISLEDASH');

  it('validates the weight settings', async () => {
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, { perPoundJmd: -5 })).status, 400);
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, { maxWeightLb: 0 })).status, 400);
  });

  it('lets a seller set a product weight', async () => {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    const created = await call('POST', '/shop/products', owner, {
      shopId, title: 'Rice', category: 'Groceries', priceJmd: 500, stockQuantity: 5, weightLb: 25, images: ['https://example.com/a.jpg'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.weightLb), 25);
    const edited = await call('PATCH', `/shop/products/${created.body.id}`, owner, { weightLb: 20.5 });
    assert.equal(Number(edited.body.weightLb), 20.5);
  });

  it('weighs the whole delivery together; products with no weight count as 0', async () => {
    const s = await shopWith([4, null]);
    // 3 × 4 lb + 2 × none = 12 lb → 2 lb over → J$100 on top of J$300, and no extra-item charge.
    const res = await quote([s.line(0, 3), s.line(1, 2)]);
    const option = isleDashOption(res.body, s.key);
    assert.equal(option.feeJmd, '400.00');
    assert.equal(option.weightLb, '12.0');
    assert.match(option.detail, /12 lb \(\+J\$100 for weight\)/);

    const light = isleDashOption((await quote([s.line(0, 1)])).body, s.key);
    assert.equal(light.feeJmd, '300.00');
    assert.doesNotMatch(light.detail, /lb/);
  });

  it('charges checkout the weight fee and records the weight', async () => {
    const s = await shopWith([7]);
    const res = await call('POST', '/orders/checkout', customer, {
      items: [s.line(0, 2)],
      deliveryMethods: { [s.key]: 'ISLEDASH' },
      deliveryAddress: '1 Main Street',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const order = res.body.orders[0];
    assert.equal(Number(order.driverFeeJmd), 500, '300 + 4 lb × 50');
    assert.equal(Number(order.deliveryWeightLb), 14);
  });

  it("doesn't offer IsleDash over the max weight, and says why", async () => {
    const s = await shopWith([60]);
    const res = await quote([s.line(0, 2)]);
    assert.equal(isleDashOption(res.body, s.key), undefined);
    assert.match(res.body.sellers[0].isleDashUnavailable, /Too heavy for IsleDash/);
    const checkout = await call('POST', '/orders/checkout', customer, {
      items: [s.line(0, 2)],
      deliveryMethods: { [s.key]: 'ISLEDASH' },
      deliveryAddress: '1 Main Street',
    });
    assert.equal(checkout.status, 400);
    assert.match(checkout.body.error, /Too heavy/);
  });
});
