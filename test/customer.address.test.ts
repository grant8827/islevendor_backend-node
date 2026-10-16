import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createLedgerAccount, createShop, createUser, ensurePlatformAccount, prisma, startServer, type TestServer } from './helpers.js';

const ADDRESS = {
  addressLine1: '12 Hope Road',
  addressLine2: 'Apt 4',
  town: 'Liguanea',
  parish: 'St. Andrew',
  landmark: 'Opposite the Texaco',
  deliveryInstructions: 'Call on arrival',
  location: { latitude: 18.018342, longitude: -76.775731 },
};

describe('customer addresses', () => {
  let server: TestServer;
  before(async () => {
    server = await startServer();
    await ensurePlatformAccount();
  });
  after(async () => server.close());

  const signUp = (extra: Record<string, unknown> = {}) =>
    api(server, '/auth/register', {
      method: 'POST',
      body: { email: `${randomUUID()}@islevendor.test`, password: 'Passw0rd!', fullName: 'Kim Brown', phoneNumber: '8765550123', role: 'CUSTOMER', address: ADDRESS, ...extra },
    });

  describe('signing up', () => {
    it('saves the delivery address with the new account', async () => {
      const res = await signUp();
      assert.equal(res.status, 201);
      const saved = await api(server, '/auth/address', { token: res.body.token });
      assert.equal(saved.status, 200);
      const a = saved.body.address;
      assert.equal(a.addressLine1, '12 Hope Road');
      assert.equal(a.parish, 'St. Andrew');
      assert.equal(a.landmark, 'Opposite the Texaco');
      assert.deepEqual(a.location, { latitude: 18.018342, longitude: -76.775731 });
      assert.equal(a.formatted, '12 Hope Road, Apt 4, Liguanea, St. Andrew — Landmark: Opposite the Texaco — Note: Call on arrival');
    });

    it('needs a street, town and real parish; the map pin is optional but must be in Jamaica', async () => {
      assert.equal((await signUp({ address: undefined })).status, 400);
      assert.equal((await signUp({ address: { ...ADDRESS, addressLine1: '' } })).status, 400);
      assert.equal((await signUp({ address: { ...ADDRESS, town: '' } })).status, 400);
      assert.equal((await signUp({ address: { ...ADDRESS, parish: 'Miami' } })).status, 400);
      assert.equal((await signUp({ address: { ...ADDRESS, location: { latitude: 25.76, longitude: -80.19 } } })).status, 400);
      const noPin = await signUp({ address: { ...ADDRESS, location: null, landmark: '', addressLine2: '' } });
      assert.equal(noPin.status, 201);
      const saved = await api(server, '/auth/address', { token: noPin.body.token });
      assert.equal(saved.body.address.location, null);
      assert.equal(saved.body.address.landmark, null);
    });

    it('still accepts customers only', async () => {
      assert.equal((await signUp({ role: 'WAREHOUSE' })).status, 400);
    });
  });

  describe('My Account', () => {
    it('lets a customer change their address, and nobody else see it', async () => {
      const me = await createUser('CUSTOMER');
      assert.equal((await api(server, '/auth/address', { token: me.token })).body.address, null);

      const put = await api(server, '/auth/address', { method: 'PUT', token: me.token, body: { ...ADDRESS, town: 'Half Way Tree' } });
      assert.equal(put.status, 200);
      assert.equal(put.body.address.town, 'Half Way Tree');
      const again = await api(server, '/auth/address', { method: 'PUT', token: me.token, body: { ...ADDRESS, parish: 'St. Catherine', town: 'Portmore' } });
      assert.equal(again.body.address.parish, 'St. Catherine');
      assert.equal(await prisma.customerAddress.count({ where: { userId: me.id } }), 1);

      assert.equal((await api(server, '/auth/address')).status, 401);
      const other = await createUser('CUSTOMER');
      assert.equal((await api(server, '/auth/address', { token: other.token })).body.address, null);
    });
  });

  describe('checkout', () => {
    async function shopWithProduct() {
      const owner = await createUser('STORE');
      const shopId = await createShop(owner.id);
      await createLedgerAccount(owner.id, 'STORE');
      await prisma.shop.update({ where: { id: shopId }, data: { offersPickup: true } });
      const product = await prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title: 'Speaker', category: 'Electronics', priceJmd: 1000, stockQuantity: 5 } });
      return { shopId, product };
    }
    const cart = (shopId: string, productId: string, method: string, extra: Record<string, unknown> = {}) => ({
      items: [{ kind: 'STORE', storeId: shopId, masterProductId: productId, quantity: 1 }],
      deliveryMethods: { [`shop:${shopId}`]: method },
      ...extra,
    });

    it('delivers to the saved address, with its map pin, when none is entered', async () => {
      const me = await createUser('CUSTOMER');
      await api(server, '/auth/address', { method: 'PUT', token: me.token, body: ADDRESS });
      const { shopId, product } = await shopWithProduct();

      const res = await api(server, '/orders/checkout', { method: 'POST', token: me.token, body: cart(shopId, product.id, 'ISLEDASH') });
      assert.equal(res.status, 201);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orders[0].id } });
      assert.match(order.deliveryAddress, /^12 Hope Road, Apt 4, Liguanea, St\. Andrew — Landmark: Opposite the Texaco/);
      assert.equal(Number(order.deliveryLatitude), 18.018342);
      assert.equal(Number(order.deliveryLongitude), -76.775731);

      // The seller and the order page see where to go.
      const view = await api(server, `/orders/${order.id}`, { token: me.token });
      assert.deepEqual(view.body.deliveryLocation, { latitude: 18.018342, longitude: -76.775731 });
    });

    it('uses an address and pin typed at checkout instead', async () => {
      const me = await createUser('CUSTOMER');
      await api(server, '/auth/address', { method: 'PUT', token: me.token, body: ADDRESS });
      const { shopId, product } = await shopWithProduct();
      const res = await api(server, '/orders/checkout', {
        method: 'POST',
        token: me.token,
        body: cart(shopId, product.id, 'ISLEDASH', { deliveryAddress: '5 Main Street, Ocho Rios, St. Ann', deliveryLocation: { latitude: 18.4074, longitude: -77.1031 } }),
      });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orders[0].id } });
      assert.equal(order.deliveryAddress, '5 Main Street, Ocho Rios, St. Ann');
      assert.equal(Number(order.deliveryLatitude), 18.4074);
    });

    it('asks for an address when there is none saved, and needs no pin for pickup', async () => {
      const me = await createUser('CUSTOMER');
      const { shopId, product } = await shopWithProduct();
      const none = await api(server, '/orders/checkout', { method: 'POST', token: me.token, body: cart(shopId, product.id, 'ISLEDASH') });
      assert.equal(none.status, 400);
      assert.match(none.body.error, /delivery address/);

      const pickup = await api(server, '/orders/checkout', { method: 'POST', token: me.token, body: cart(shopId, product.id, 'PICKUP', { deliveryLocation: ADDRESS.location }) });
      assert.equal(pickup.status, 201);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: pickup.body.orders[0].id } });
      assert.match(order.deliveryAddress, /^Customer pickup/);
      assert.equal(order.deliveryLatitude, null);
    });

    it('refuses a pin outside Jamaica', async () => {
      const me = await createUser('CUSTOMER');
      const { shopId, product } = await shopWithProduct();
      const res = await api(server, '/orders/checkout', {
        method: 'POST',
        token: me.token,
        body: cart(shopId, product.id, 'ISLEDASH', { deliveryAddress: 'Somewhere', deliveryLocation: { latitude: 40.7, longitude: -74 } }),
      });
      assert.equal(res.status, 400);
    });
  });
});
