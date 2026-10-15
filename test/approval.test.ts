import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  acceptDriver,
  api,
  createDriver,
  createLedgerAccount,
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
import { env } from '../src/env.js';

// What IsleVendor's admin approval gates (lib/eligibility.ts): a business
// that hasn't been approved can't list, sell, dispatch or withdraw.
describe('admin approval gates', () => {
  let server: TestServer;
  let customer: TestUser;

  before(async () => {
    server = await startServer();
    customer = await createUser('CUSTOMER');
  });
  after(() => server.close());

  const post = (path: string, user: TestUser, body: unknown = {}) => api(server, path, { method: 'POST', token: user.token, body });
  const productBody = (warehouseId: string) => ({
    warehouseId,
    title: 'Test item',
    category: 'Electronics',
    wholesalePriceJmd: 1000,
    stockQuantity: 5,
    images: ['https://example.com/item.png'],
  });
  const shopProductBody = (shopId: string) => ({
    shopId,
    title: 'Test item',
    category: 'Electronics',
    priceJmd: 1000,
    stockQuantity: 5,
    images: ['https://example.com/item.png'],
  });

  /** A warehouse + reseller pair with one product listed on the reseller's store. */
  async function affiliateListing(status: { warehouse?: 'PENDING_REVIEW' | 'APPROVED'; reseller?: 'PENDING_REVIEW' | 'APPROVED' } = {}) {
    const [warehouseOwner, reseller] = await Promise.all([createUser('WAREHOUSE'), createUser('RESELLER')]);
    const warehouseId = await createWarehouse(warehouseOwner.id, status.warehouse ?? 'APPROVED');
    const storeId = await createResellerStore(reseller.id, status.reseller ?? 'APPROVED');
    const product = await prisma.masterProduct.create({
      data: { warehouseId, sku: `SKU-${randomUUID()}`, title: 'Listed item', category: 'Electronics', wholesalePriceJmd: 1000, stockQuantity: 5 },
    });
    const listing = await prisma.storeListing.create({ data: { storeId, masterProductId: product.id, retailPriceJmd: 1300 } });
    const store = await prisma.resellerStore.findUniqueOrThrow({ where: { id: storeId } });
    return { warehouseOwner, reseller, warehouseId, storeId, product, listing, slug: store.slug };
  }

  async function shopWithProduct(status: 'PENDING_REVIEW' | 'APPROVED') {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id, status);
    const product = await prisma.shopProduct.create({
      data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Shop item', category: 'Electronics', priceJmd: 1000, stockQuantity: 5 },
    });
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    return { owner, shopId, product, slug: shop.slug };
  }

  describe('listing', () => {
    it('lets only an approved warehouse add products and assign them to resellers', async () => {
      const owner = await createUser('WAREHOUSE');
      const pending = await createWarehouse(owner.id, 'PENDING_REVIEW');
      const approved = await createWarehouse(owner.id, 'APPROVED');

      const refused = await post('/warehouse/products', owner, productBody(pending));
      assert.equal(refused.status, 403);
      assert.match(refused.body.error, /awaiting approval/);
      assert.equal((await post('/warehouse/products', owner, productBody(approved))).status, 201);

      const { storeId, product } = await affiliateListing();
      const grant = (warehouseId: string) =>
        api(server, `/warehouse/${warehouseId}/resellers/${storeId}/grants`, { method: 'PUT', token: owner.token, body: { masterProductId: product.id, granted: true } });
      assert.equal((await grant(pending)).status, 403);
    });

    it('lets only an approved shop add products', async () => {
      const owner = await createUser('STORE');
      const pending = await createShop(owner.id, 'PENDING_REVIEW');
      const rejected = await createShop(owner.id, 'REJECTED');
      const approved = await createShop(owner.id, 'APPROVED');

      assert.equal((await post('/shop/products', owner, shopProductBody(pending))).status, 403);
      const res = await post('/shop/products', owner, shopProductBody(rejected));
      assert.equal(res.status, 403);
      assert.match(res.body.error, /not approved/);
      assert.equal((await post('/shop/products', owner, shopProductBody(approved))).status, 201);
    });

    it('lets only an approved reseller list a granted product', async () => {
      const warehouseOwner = await createUser('WAREHOUSE');
      const warehouseId = await createWarehouse(warehouseOwner.id);
      const product = await prisma.masterProduct.create({
        data: { warehouseId, sku: `SKU-${randomUUID()}`, title: 'Granted item', category: 'Electronics', wholesalePriceJmd: 1000 },
      });

      for (const [status, expected] of [['PENDING_REVIEW', 403], ['APPROVED', 201]] as const) {
        const reseller = await createUser('RESELLER');
        const storeId = await createResellerStore(reseller.id, status);
        await prisma.resellerAuthorization.create({ data: { storeId, warehouseId, status: 'APPROVED' } });
        await prisma.resellerProductGrant.create({ data: { storeId, masterProductId: product.id } });
        assert.equal((await post(`/commerce/stores/${storeId}/listings`, reseller, { masterProductId: product.id })).status, expected, status);
      }
    });
  });

  describe('selling', () => {
    const listingIds = async () => ((await api(server, '/commerce/listings')).body as { id: string }[]).map((l) => l.id);

    it('shows approved sellers in the marketplace and on their storefront', async () => {
      const affiliate = await affiliateListing();
      const shop = await shopWithProduct('APPROVED');
      const ids = await listingIds();
      assert.ok(ids.includes(affiliate.listing.id));
      assert.ok(ids.includes(shop.product.id));
      assert.equal((await api(server, `/commerce/listings/${affiliate.listing.id}`)).status, 200);
      assert.equal((await api(server, `/commerce/stores/${shop.slug}`)).status, 200);
    });

    it('hides anything sold by, or stocked from, a business that is not approved', async () => {
      const pendingReseller = await affiliateListing({ reseller: 'PENDING_REVIEW' });
      const pendingWarehouse = await affiliateListing({ warehouse: 'PENDING_REVIEW' });
      const pendingShop = await shopWithProduct('PENDING_REVIEW');
      const ids = await listingIds();

      for (const id of [pendingReseller.listing.id, pendingWarehouse.listing.id, pendingShop.product.id]) {
        assert.ok(!ids.includes(id), `${id} must not be in the marketplace`);
        assert.equal((await api(server, `/commerce/listings/${id}`)).status, 404);
      }
      assert.equal((await api(server, `/commerce/stores/${pendingReseller.slug}`)).status, 404);
      assert.equal((await api(server, `/commerce/stores/${pendingShop.slug}`)).status, 404);

      // An approved reseller's storefront drops items from a warehouse that isn't approved.
      const storefront = await api(server, `/commerce/stores/${pendingWarehouse.slug}`);
      assert.equal(storefront.status, 200);
      assert.deepEqual(storefront.body.listings, []);
    });

    it('refuses checkout from a business that is not approved', async () => {
      const pendingReseller = await affiliateListing({ reseller: 'PENDING_REVIEW' });
      const pendingWarehouse = await affiliateListing({ warehouse: 'PENDING_REVIEW' });
      const pendingShop = await shopWithProduct('PENDING_REVIEW');
      const approvedShop = await shopWithProduct('APPROVED');
      const checkout = (body: object) => post('/orders', customer, { quantity: 1, deliveryAddress: '1 Test Lane', ...body });

      for (const listing of [pendingReseller, pendingWarehouse]) {
        assert.equal((await checkout({ kind: 'AFFILIATE', storeId: listing.storeId, masterProductId: listing.product.id })).status, 404);
      }
      assert.equal((await checkout({ kind: 'STORE', storeId: pendingShop.shopId, masterProductId: pendingShop.product.id })).status, 404);
      assert.equal((await checkout({ kind: 'STORE', storeId: approvedShop.shopId, masterProductId: approvedShop.product.id })).status, 201);
      assert.equal(await prisma.order.count({ where: { shopId: pendingShop.shopId } }), 0);
    });
  });

  describe('dispatching', () => {
    it('refuses to send out or label an order for a business that is not approved', async () => {
      const shop = await shopWithProduct('PENDING_REVIEW');
      const order = await createOrder({ customerId: customer.id, shopId: shop.shopId, status: 'PACKING' });
      assert.equal((await post(`/dispatch/orders/${order.id}/ready`, shop.owner)).status, 403);
      assert.equal((await post(`/dispatch/orders/${order.id}/pickup-token`, shop.owner)).status, 403);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PACKING');
    });

    it("offers a job only to drivers the business has accepted", async () => {
      const shop = await shopWithProduct('APPROVED');
      const [accepted, notAccepted, acceptedElsewhere, suspended] = await Promise.all([createDriver(), createDriver(), createDriver(), createDriver()]);
      await acceptDriver(accepted, { shopId: shop.shopId });
      await acceptDriver(acceptedElsewhere, { shopId: (await shopWithProduct('APPROVED')).shopId });
      await acceptDriver(suspended, { shopId: shop.shopId });
      await prisma.deliveryApplication.updateMany({ where: { shopId: shop.shopId, driver: { userId: suspended.id } }, data: { status: 'SUSPENDED' } });

      // Everyone online, right next to the shop.
      await prisma.$executeRaw`
        UPDATE driver_profiles SET is_online = TRUE, current_location = ST_SetSRID(ST_MakePoint(-76.79, 18.011), 4326)
        WHERE user_id IN (${accepted.id}::uuid, ${notAccepted.id}::uuid, ${acceptedElsewhere.id}::uuid, ${suspended.id}::uuid)
      `;

      const order = await createOrder({ customerId: customer.id, shopId: shop.shopId, status: 'PACKING' });
      const res = await post(`/dispatch/orders/${order.id}/ready`, shop.owner);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.offeredTo, [accepted.id]);
    });

    it('reports when none of the business’s drivers are available', async () => {
      const shop = await shopWithProduct('APPROVED');
      const order = await createOrder({ customerId: customer.id, shopId: shop.shopId, status: 'PACKING' });
      const res = await post(`/dispatch/orders/${order.id}/ready`, shop.owner);
      assert.equal(res.body.dispatched, false);
      assert.match(res.body.reason, /accepted drivers/);
    });
  });

  describe('drivers applying to businesses', () => {
    it('requires IsleVendor to have approved the driver, and the business', async () => {
      const shop = await shopWithProduct('APPROVED');
      const pendingShop = await shopWithProduct('PENDING_REVIEW');
      const pendingDriver = await createDriver({ isKycApproved: false, applicantStatus: 'PENDING_REVIEW' });
      const approvedDriver = await createDriver();

      const refused = await post('/delivery-applications', pendingDriver, { shopId: shop.shopId });
      assert.equal(refused.status, 403);
      assert.match(refused.body.error, /approved your driver application/);

      assert.equal((await post('/delivery-applications', approvedDriver, { shopId: pendingShop.shopId })).status, 404);
      assert.equal((await post('/delivery-applications', approvedDriver, { shopId: shop.shopId })).status, 201);
    });

    it('lists only approved businesses to apply to', async () => {
      const pendingShop = await shopWithProduct('PENDING_REVIEW');
      const approvedShop = await shopWithProduct('APPROVED');
      const owner = await createUser('WAREHOUSE');
      const pendingWarehouse = await createWarehouse(owner.id, 'PENDING_REVIEW');

      const shops = ((await api(server, '/shop')).body as { id: string }[]).map((s) => s.id);
      assert.ok(shops.includes(approvedShop.shopId) && !shops.includes(pendingShop.shopId));
      const warehouses = ((await api(server, '/warehouse')).body as { id: string }[]).map((w) => w.id);
      assert.ok(!warehouses.includes(pendingWarehouse));
    });
  });

  describe('withdrawing', () => {
    it('opens only once the business is approved', async () => {
      env.ENABLE_WITHDRAWALS = true;
      try {
        const pending = await shopWithProduct('PENDING_REVIEW');
        await createLedgerAccount(pending.owner.id, 'STORE');
        const refused = await post('/ledger/withdraw', pending.owner);
        assert.equal(refused.status, 403);
        assert.match(refused.body.error, /approved/);

        const approved = await shopWithProduct('APPROVED');
        await createLedgerAccount(approved.owner.id, 'STORE');
        assert.equal((await post('/ledger/withdraw', approved.owner)).status, 409, 'past the gate: just nothing to withdraw yet');
      } finally {
        env.ENABLE_WITHDRAWALS = false;
      }
    });
  });

  describe("dashboards' quick add forms", () => {
    const newWarehouse = { name: 'Second depot', addressLine: '9 Depot Road', lat: 18.0, lng: -76.8 };

    it('require payout details on file, and create the business awaiting review', async () => {
      const owner = await createUser('WAREHOUSE');
      const missing = await post('/warehouse', owner, newWarehouse);
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /payout details/);

      const firstId = await createWarehouse(owner.id);
      await prisma.warehouse.update({ where: { id: firstId }, data: { payoutMethod: 'BANK' } });
      const created = await post('/warehouse', owner, newWarehouse);
      assert.equal(created.status, 201);
      assert.equal((await prisma.warehouse.findUniqueOrThrow({ where: { id: created.body.id } })).applicantStatus, 'PENDING_REVIEW');
    });

    it('do the same for a new shop', async () => {
      const owner = await createUser('STORE');
      const body = { shopName: 'Second shop', slug: `shop-${randomUUID().slice(0, 8)}`, addressLine: '3 Market St', lat: 18.0, lng: -76.8 };
      assert.equal((await post('/shop', owner, body)).status, 400);

      const firstId = await createShop(owner.id);
      await prisma.shop.update({ where: { id: firstId }, data: { payoutMethod: 'LYNK_WALLET', lynkWalletId: 'abc' } });
      const created = await post('/shop', owner, body);
      assert.equal(created.status, 201);
      assert.equal((await prisma.shop.findUniqueOrThrow({ where: { id: created.body.id } })).applicantStatus, 'PENDING_REVIEW');
    });
  });
});
