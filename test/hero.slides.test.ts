import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, createShop, createUser, prisma, startServer, type TestServer, type TestUser } from './helpers.js';

// The home page hero cards: items an admin picks from what's listed on the site.
describe('hero slides', () => {
  let server: TestServer;
  let admin: TestUser;
  let shopId: string;

  before(async () => {
    server = await startServer();
    admin = await createUser('ADMIN');
    shopId = await createShop((await createUser('STORE')).id);
    await prisma.heroSlide.deleteMany();
  });
  after(async () => {
    await prisma.heroSlide.deleteMany();
    await server.close();
  });

  const call = (method: string, path: string, user: TestUser | null, body?: unknown) => api(server, path, { method, token: user?.token, body });
  const listItem = (title: string) =>
    prisma.shopProduct.create({ data: { shopId, sku: `SKU-${randomUUID()}`, title, category: 'Electronics', priceJmd: 1000, stockQuantity: 5, imageUrl: `https://example.com/${title}.jpg` } });

  it('only admins can manage them', async () => {
    const item = await listItem('Fan');
    const seller = await createUser('STORE');
    assert.equal((await call('POST', '/admin/hero-slides', seller, { listingId: item.id })).status, 403);
    assert.equal((await call('GET', '/admin/hero-slides', null)).status, 401);
  });

  it('only takes items listed on the site, once each, on a site colour', async () => {
    const item = await listItem('Kettle');
    const hidden = await prisma.shopProduct.update({ where: { id: (await listItem('Hidden')).id }, data: { isActive: false } });
    assert.equal((await call('POST', '/admin/hero-slides', admin, { listingId: randomUUID() })).status, 400);
    assert.equal((await call('POST', '/admin/hero-slides', admin, { listingId: hidden.id })).status, 400);
    assert.equal((await call('POST', '/admin/hero-slides', admin, { listingId: item.id, background: '#ff0000' })).status, 400);
    assert.equal((await call('POST', '/admin/hero-slides', admin, { listingId: item.id })).status, 201);
    assert.equal((await call('POST', '/admin/hero-slides', admin, { listingId: item.id })).status, 409);
    await prisma.heroSlide.deleteMany();
  });

  it('shows the item’s image and name, in order, and drops items no longer for sale', async () => {
    const tv = await listItem('TV');
    const radio = await prisma.shopProduct.update({ where: { id: (await listItem('Radio')).id }, data: { discountPercent: 25 } });
    const a = (await call('POST', '/admin/hero-slides', admin, { listingId: tv.id, background: 'secondary' })).body;
    const b = (await call('POST', '/admin/hero-slides', admin, { listingId: radio.id, background: 'primary' })).body;
    assert.deepEqual(a.item, { id: tv.id, title: 'TV', imageUrl: 'https://example.com/TV.jpg', discountPercent: 0 });

    let pub = await call('GET', '/hero-slides', null);
    assert.equal(pub.status, 200);
    assert.deepEqual(pub.body, [
      { id: a.id, background: 'secondary', item: { id: tv.id, title: 'TV', imageUrl: 'https://example.com/TV.jpg', discountPercent: 0 } },
      { id: b.id, background: 'primary', item: { id: radio.id, title: 'Radio', imageUrl: 'https://example.com/Radio.jpg', discountPercent: 25 } },
    ]);

    assert.equal((await call('PUT', '/admin/hero-slides/order', admin, { ids: [a.id] })).status, 400);
    assert.equal((await call('PUT', '/admin/hero-slides/order', admin, { ids: [b.id, a.id] })).status, 200);
    pub = await call('GET', '/hero-slides', null);
    assert.deepEqual(pub.body.map((s: any) => s.item.title), ['Radio', 'TV']);

    // Hidden by the admin → off the home page.
    assert.equal((await call('PATCH', `/admin/hero-slides/${b.id}`, admin, { isActive: false })).status, 200);
    // The seller stops selling it → off the home page, flagged for the admin.
    await prisma.shopProduct.update({ where: { id: tv.id }, data: { isActive: false } });
    assert.deepEqual((await call('GET', '/hero-slides', null)).body, []);
    const adminList = (await call('GET', '/admin/hero-slides', admin)).body;
    assert.equal(adminList.find((s: any) => s.id === a.id).item, null);

    assert.equal((await call('DELETE', `/admin/hero-slides/${a.id}`, admin)).status, 204);
    assert.equal((await call('DELETE', `/admin/hero-slides/${a.id}`, admin)).status, 404);
    assert.ok(await prisma.auditEvent.findFirst({ where: { action: 'hero_slide.deleted', targetId: a.id } }));
  });
});
