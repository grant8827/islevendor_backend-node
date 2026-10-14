import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  api,
  createLedgerAccount,
  createUser,
  createWarehouse,
  ensurePlatformAccount,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { env } from '../src/env.js';

// A warehouse's own storefront, selling its stock directly.
describe('warehouse house store', () => {
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

  /** An approved warehouse (20% reseller commission) with one J$1,000 product. */
  async function warehouse(status: 'APPROVED' | 'PENDING_REVIEW' = 'APPROVED') {
    const owner = await createUser('WAREHOUSE');
    const warehouseId = await createWarehouse(owner.id, status);
    await createLedgerAccount(owner.id, 'WAREHOUSE');
    const product = await prisma.masterProduct.create({
      data: { warehouseId, sku: `SKU-${randomUUID()}`, title: 'Generator', category: 'Electronics', wholesalePriceJmd: 1000, stockQuantity: 5 },
    });
    return { owner, warehouseId, product, slug: `house-${randomUUID().slice(0, 8)}` };
  }

  async function openStore(w: Awaited<ReturnType<typeof warehouse>>) {
    const res = await call('POST', `/warehouse/${w.warehouseId}/store`, w.owner, { storeName: 'Depot Direct', slug: w.slug });
    assert.equal(res.status, 201);
    const listing = await call('POST', `/warehouse/${w.warehouseId}/store/listings`, w.owner, { masterProductId: w.product.id });
    assert.equal(listing.status, 201);
    return { storeId: res.body.id as string, listingId: listing.body.id as string };
  }

  describe('setting up', () => {
    it('lets the owner open one store and list its own products, priced like a reseller listing', async () => {
      const w = await warehouse();
      const { storeId } = await openStore(w);

      const view = await call('GET', `/warehouse/${w.warehouseId}/store`, w.owner);
      assert.equal(view.body.id, storeId);
      assert.equal(view.body.listings.length, 1);
      // 1,000 wholesale + 20% warehouse commission + 5% platform.
      assert.equal(view.body.listings[0].retailPriceJmd, '1250.00');

      assert.equal((await call('POST', `/warehouse/${w.warehouseId}/store`, w.owner, { storeName: 'Again', slug: `x-${randomUUID().slice(0, 8)}` })).status, 409);
    });

    it('is the owner’s or an admin’s job, and needs an approved warehouse', async () => {
      const w = await warehouse();
      const staff = await createUser('WAREHOUSE');
      await prisma.warehouseMember.create({ data: { warehouseId: w.warehouseId, userId: staff.id, role: 'STAFF' } });
      assert.equal((await call('POST', `/warehouse/${w.warehouseId}/store`, staff, { storeName: 'Mine', slug: w.slug })).status, 403);
      assert.equal((await call('POST', `/warehouse/${w.warehouseId}/store`, await createUser('WAREHOUSE'), { storeName: 'Mine', slug: w.slug })).status, 403);

      const pending = await warehouse('PENDING_REVIEW');
      assert.equal((await call('POST', `/warehouse/${pending.warehouseId}/store`, pending.owner, { storeName: 'Mine', slug: pending.slug })).status, 403);
    });

    it("won't list another warehouse's product, or take an address already in use", async () => {
      const w = await warehouse();
      const other = await warehouse();
      await openStore(w);
      assert.equal((await call('POST', `/warehouse/${w.warehouseId}/store/listings`, w.owner, { masterProductId: other.product.id })).status, 404);
      assert.equal((await call('POST', `/warehouse/${other.warehouseId}/store`, other.owner, { storeName: 'Copy', slug: w.slug })).status, 409);
    });

    it('stays out of the admin applicant queue', async () => {
      const w = await warehouse();
      const { storeId } = await openStore(w);
      const approved = (await call('GET', '/admin/applicants?status=APPROVED&type=reseller', admin)).body as { id: string }[];
      assert.ok(!approved.some((a) => a.id === storeId));
    });
  });

  describe('selling', () => {
    it('appears in the marketplace and on its own storefront, and leaves when taken down', async () => {
      const w = await warehouse();
      const { listingId } = await openStore(w);
      const inMarketplace = async () => ((await call('GET', '/commerce/listings')).body as { id: string }[]).some((l) => l.id === listingId);

      assert.ok(await inMarketplace());
      const storefront = await call('GET', `/commerce/stores/${w.slug}`);
      assert.equal(storefront.body.storeName, 'Depot Direct');
      assert.deepEqual(storefront.body.listings.map((l: any) => l.id), [listingId]);

      assert.equal((await call('DELETE', `/warehouse/${w.warehouseId}/store/listings/${listingId}`, w.owner)).status, 204);
      assert.ok(!(await inMarketplace()));
      assert.equal((await call('POST', `/warehouse/${w.warehouseId}/store/listings`, w.owner, { masterProductId: w.product.id })).status, 201);
      assert.ok(await inMarketplace(), 'listing it again turns it back on');
    });

    it('pays the warehouse both its wholesale price and the margin', async () => {
      const w = await warehouse();
      const { storeId } = await openStore(w);
      const [order] = (
        await call('POST', '/orders/checkout', customer, {
          items: [{ kind: 'AFFILIATE', storeId, masterProductId: w.product.id, quantity: 2 }],
          deliveryMethods: { [`warehouse:${w.warehouseId}`]: 'ISLEDASH' },
          deliveryAddress: '1 Customer Lane',
        })
      ).body;
      assert.equal(Number(order.totalPaidJmd), 2500 + 300 + 150);

      const transaction_id = `txn-${randomUUID()}`;
      const hash = createHash('md5').update(`${transaction_id}${order.id}test-wipay-key`).digest('hex');
      assert.equal((await call('POST', '/ledger/webhooks/wipay', undefined, { order_id: order.id, transaction_id, hash, status: 'success' })).status, 200);

      const legs = await prisma.ledgerTransaction.findMany({ where: { orderId: order.id }, include: { recipientAccount: true } });
      const byType = Object.fromEntries(legs.map((l) => [l.recipientAccount.accountType, Number(l.amountJmd)]));
      // 2,000 wholesale + 400 margin to the warehouse; 100 commission + 450 IsleDash held by the platform.
      assert.deepEqual(byType, { WAREHOUSE: 2400, PLATFORM: 550 });

      const warehouseOrders = (await call('GET', `/warehouse/${w.warehouseId}/orders`, w.owner)).body as any[];
      const mine = warehouseOrders.find((o) => o.id === order.id);
      assert.equal(mine.resellerStore.storeName, 'Depot Direct');
      assert.equal((await call('GET', `/orders/${order.id}`, w.owner)).status, 200);
    });
  });
});
