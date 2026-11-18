import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { api, createShop, createUser, createWarehouse, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { deliveryMiles, distanceFee, isleDashQuote, straightLineMiles, type IsleDashPricing } from '../src/lib/isleDashPricing.js';

const pricing: IsleDashPricing = {
  baseFeeJmd: new Decimal(300),
  includedMiles: new Decimal(3),
  perMileJmd: new Decimal(60),
  minFeeJmd: new Decimal(300),
  maxFeeJmd: new Decimal(2500),
  maxMiles: new Decimal(40),
  extraItemPercent: 50,
  fallbackFeeJmd: new Decimal(400),
  roadAdjustPercent: 30,
};

// Half Way Tree, Kingston and Spanish Town — about 10.6 straight-line miles apart.
const KINGSTON = { latitude: 18.0123, longitude: -76.7965 };
const SPANISH_TOWN = { latitude: 17.9911, longitude: -76.9574 };
const MONTEGO_BAY = { latitude: 18.4762, longitude: -77.8939 };

describe('IsleDash distance pricing (math)', () => {
  it('measures straight-line miles', () => {
    // One degree of latitude is ~69.09 miles.
    assert.ok(Math.abs(straightLineMiles({ latitude: 18, longitude: -77 }, { latitude: 19, longitude: -77 }) - 69.09) < 0.05);
  });

  it('adds the road adjustment and rounds to a tenth of a mile', () => {
    const straight = straightLineMiles(KINGSTON, SPANISH_TOWN);
    assert.equal(deliveryMiles(pricing, KINGSTON, SPANISH_TOWN).toString(), new Decimal(straight * 1.3).toDecimalPlaces(1).toString());
    assert.equal(deliveryMiles({ roadAdjustPercent: 0 }, KINGSTON, SPANISH_TOWN).toString(), new Decimal(straight).toDecimalPlaces(1).toString());
  });

  it('charges the base fee for the included miles, then per mile, between min and max', () => {
    assert.equal(distanceFee(pricing, new Decimal(2)).toString(), '300');
    assert.equal(distanceFee(pricing, new Decimal(13)).toString(), '900', '300 + 10 × 60');
    assert.equal(distanceFee(pricing, new Decimal(13.25)).toString(), '915', 'rounded to the dollar');
    assert.equal(distanceFee(pricing, new Decimal(100)).toString(), '2500', 'capped at the max');
    assert.equal(distanceFee({ ...pricing, baseFeeJmd: new Decimal(100) }, new Decimal(0)).toString(), '300', 'never below the min');
    assert.equal(distanceFee({ ...pricing, maxFeeJmd: null }, new Decimal(100)).toString(), '6120', 'no cap');
  });

  it('falls back without both pins, and refuses beyond the max distance', () => {
    const noBuyer = isleDashQuote(pricing, KINGSTON, null);
    assert.ok(noBuyer.available);
    assert.equal(noBuyer.rate.baseFeeJmd.toString(), '400');
    assert.equal(noBuyer.distanceMiles, null);
    assert.equal(noBuyer.missingPin, 'buyer');
    assert.equal(isleDashQuote(pricing, null, KINGSTON).available && isleDashQuote(pricing, null, KINGSTON).missingPin, 'seller');

    const far = isleDashQuote(pricing, KINGSTON, MONTEGO_BAY);
    assert.equal(far.available, false);
    assert.match(!far.available ? far.reason : '', /limit is 40 mi/);
    assert.ok(isleDashQuote({ ...pricing, maxMiles: null }, KINGSTON, MONTEGO_BAY).available);
  });
});

describe('IsleDash distance pricing (API)', () => {
  let server: TestServer;
  let customer: TestUser, admin: TestUser;
  const DEFAULTS = {
    baseFeeJmd: 300,
    includedMiles: 0,
    perMileJmd: 0,
    minFeeJmd: 0,
    maxFeeJmd: null,
    maxMiles: null,
    extraItemPercent: 50,
    fallbackFeeJmd: 300,
    roadAdjustPercent: 30,
  };
  const DISTANCE = {
    baseFeeJmd: 300,
    includedMiles: 3,
    perMileJmd: 60,
    minFeeJmd: 300,
    maxFeeJmd: 2500,
    maxMiles: 40,
    extraItemPercent: 50,
    fallbackFeeJmd: 400,
    roadAdjustPercent: 30,
  };

  before(async () => {
    server = await startServer();
    [customer, admin] = await Promise.all([createUser('CUSTOMER'), createUser('ADMIN')]);
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, DISTANCE)).status, 200);
  });
  after(async () => {
    await call('PUT', '/admin/settings/isledash', admin, DEFAULTS);
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  async function shop() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    assert.equal((await call('PUT', `/shop/${shopId}/delivery-options`, owner, { offersIsleDash: true, offersSellerDelivery: false, offersPickup: true })).status, 200);
    const product = await prisma.shopProduct.create({
      data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Item', category: 'Electronics', priceJmd: 1000, stockQuantity: 10 },
    });
    return { owner, shopId, key: `shop:${shopId}`, line: (quantity = 1) => ({ kind: 'STORE', storeId: shopId, masterProductId: product.id, quantity }) };
  }

  const quote = (items: object[], deliveryLocation?: object) => call('POST', '/orders/quote', undefined, { items, deliveryLocation });
  const isleDashOption = (body: any, key: string) => body.sellers.find((s: any) => s.key === key).options.find((o: any) => o.method === 'ISLEDASH');
  const expectedFee = (from: typeof KINGSTON, to: typeof KINGSTON) => distanceFee(pricing, deliveryMiles(pricing, from, to));

  it('validates the admin settings', async () => {
    assert.equal((await call('PUT', '/admin/settings/isledash', customer, DISTANCE)).status, 403);
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, { minFeeJmd: 3000 })).status, 400, 'min above max');
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, { perMileJmd: -1 })).status, 400);
    assert.equal((await call('PUT', '/admin/settings/isledash', admin, { unknownField: 1 })).status, 400);
    const read = await call('GET', '/admin/settings/isledash', admin);
    assert.equal(read.body.perMileJmd, '60.00');
    assert.equal(read.body.maxMiles, 40);
  });

  it('lets only the owner place a shop pin inside Jamaica, and moves the dispatch point too', async () => {
    const s = await shop();
    const stranger = await createUser('STORE');
    assert.equal((await call('PUT', `/shop/${s.shopId}/location`, stranger, KINGSTON)).status, 403);
    assert.equal((await call('PUT', `/shop/${s.shopId}/location`, s.owner, { latitude: 40.7, longitude: -74 })).status, 400);
    const res = await call('PUT', `/shop/${s.shopId}/location`, s.owner, KINGSTON);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, KINGSTON);

    const [row] = await prisma.$queryRaw<{ lat: number; lng: number }[]>`SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM shops WHERE id = ${s.shopId}::uuid`;
    assert.ok(Math.abs(row.lat - KINGSTON.latitude) < 1e-6 && Math.abs(row.lng - KINGSTON.longitude) < 1e-6);
    const mine = await call('GET', '/shop/mine', s.owner);
    assert.equal(Number(mine.body[0].pinLatitude), KINGSTON.latitude);
  });

  it('lets a warehouse owner place a pin, but not staff', async () => {
    const owner = await createUser('WAREHOUSE');
    const warehouseId = await createWarehouse(owner.id);
    assert.equal((await call('PUT', `/warehouse/${warehouseId}/location`, owner, SPANISH_TOWN)).status, 200);
    const w = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
    assert.equal(Number(w.pinLongitude), SPANISH_TOWN.longitude);
  });

  it('quotes by distance when both sides are pinned, and the fallback otherwise', async () => {
    const s = await shop();
    const unpinned = await quote([s.line()], SPANISH_TOWN);
    assert.equal(isleDashOption(unpinned.body, s.key).feeJmd, '400.00', 'seller not pinned: fallback');
    assert.equal(isleDashOption(unpinned.body, s.key).distanceMiles, null);

    await call('PUT', `/shop/${s.shopId}/location`, s.owner, KINGSTON);
    const noBuyerPin = await quote([s.line()]);
    assert.equal(isleDashOption(noBuyerPin.body, s.key).feeJmd, '400.00', 'buyer not pinned: fallback');
    assert.match(isleDashOption(noBuyerPin.body, s.key).detail, /map pin/);

    const fee = expectedFee(KINGSTON, SPANISH_TOWN);
    const priced = await quote([s.line(2)], SPANISH_TOWN);
    const option = isleDashOption(priced.body, s.key);
    assert.equal(option.firstItemFeeJmd, fee.toFixed(2));
    assert.equal(option.feeJmd, fee.times(1.5).toFixed(2), 'second item at 50%');
    assert.equal(option.distanceMiles, deliveryMiles(pricing, KINGSTON, SPANISH_TOWN).toFixed(1));
    assert.ok(fee.greaterThan(300), 'further than the included miles');
  });

  it('charges checkout the same distance fee and records the miles', async () => {
    const s = await shop();
    await call('PUT', `/shop/${s.shopId}/location`, s.owner, KINGSTON);
    const res = await call('POST', '/orders/checkout', customer, {
      items: [s.line()],
      deliveryMethods: { [s.key]: 'ISLEDASH' },
      deliveryAddress: '1 Spanish Town Road',
      deliveryLocation: SPANISH_TOWN,
    });
    assert.equal(res.status, 201);
    const order = res.body.orders[0];
    const fee = expectedFee(KINGSTON, SPANISH_TOWN);
    assert.equal(Number(order.driverFeeJmd), fee.toNumber());
    const goods = Number((await quote([s.line()], SPANISH_TOWN)).body.items[0].goodsTotalJmd);
    assert.equal(Number(order.totalPaidJmd), fee.plus(goods).toNumber());
    assert.equal(Number(order.deliveryDistanceMiles), Number(deliveryMiles(pricing, KINGSTON, SPANISH_TOWN)));
  });

  it("doesn't offer IsleDash beyond the max distance, and says why", async () => {
    const s = await shop();
    await call('PUT', `/shop/${s.shopId}/location`, s.owner, KINGSTON);
    const res = await quote([s.line()], MONTEGO_BAY);
    const seller = res.body.sellers[0];
    assert.equal(isleDashOption(res.body, s.key), undefined);
    assert.match(seller.isleDashUnavailable, /doesn't deliver this far/);
    assert.deepEqual(seller.options.map((o: any) => o.method), ['PICKUP']);

    const checkout = await call('POST', '/orders/checkout', customer, {
      items: [s.line()],
      deliveryMethods: { [s.key]: 'ISLEDASH' },
      deliveryAddress: '1 Montego Bay Road',
      deliveryLocation: MONTEGO_BAY,
    });
    assert.equal(checkout.status, 400);
    assert.match(checkout.body.error, /doesn't deliver this far/);
  });
});
