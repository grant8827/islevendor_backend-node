import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UPLOADS_DIR } from '../src/modules/uploads/uploads.routes.js';
import { api, createDriver, createOrder, createUser, createWarehouse, prisma, startServer, type TestServer, type TestUser } from './helpers.js';

// POST /dispatch/orders/:id/delivered: the driver says what the photo shows
// (the package with the recipient, or with their ID) and confirms it; the AI
// service's look at the photo is recorded but never blocks the delivery.
describe('proof of delivery', () => {
  let server: TestServer;
  let fakeAi: http.Server;
  // What the fake AI service answers next, and what it was asked.
  let aiAnswer: { status: 'passed' | 'flagged'; reason: string | null } = { status: 'passed', reason: null };
  let aiCalls = 0;
  let customer: TestUser;
  let driver: TestUser;
  let warehouseId: string;
  const photoName = `${randomUUID()}.jpg`;
  const photoUrl = `http://localhost:4000/uploads/${photoName}`;

  before(async () => {
    fakeAi = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        aiCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...aiAnswer, proof_type: 'PACKAGE_WITH_ID', faces_found: 0, id_text_found: false }));
      });
    });
    await new Promise<void>((resolve) => fakeAi.listen(18001, '127.0.0.1', resolve));
    await mkdir(UPLOADS_DIR, { recursive: true });
    await writeFile(path.join(UPLOADS_DIR, photoName), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    server = await startServer();
    customer = await createUser('CUSTOMER');
    driver = await createDriver();
    warehouseId = await createWarehouse((await createUser('WAREHOUSE')).id);
  });

  after(async () => {
    await server.close();
    fakeAi.close();
    await rm(path.join(UPLOADS_DIR, photoName), { force: true });
  });

  beforeEach(() => {
    aiAnswer = { status: 'passed', reason: null };
    aiCalls = 0;
  });

  const pickedUpOrder = () => createOrder({ customerId: customer.id, warehouseId, status: 'PICKED_UP', driverId: driver.id });
  const deliver = (orderId: string, body: Record<string, unknown>) =>
    api(server, `/dispatch/orders/${orderId}/delivered`, { method: 'POST', token: driver.token, body });
  const proof = { proofOfDeliveryImageUrl: photoUrl, proofType: 'PACKAGE_WITH_ID', confirmed: true };

  it('needs the driver to say what the photo shows, and confirm it', async () => {
    const order = await pickedUpOrder();
    assert.equal((await deliver(order.id, { ...proof, proofType: undefined })).status, 400);
    assert.equal((await deliver(order.id, { ...proof, proofType: 'A_SELFIE' })).status, 400);
    assert.equal((await deliver(order.id, { ...proof, confirmed: false })).status, 400);
    assert.equal((await deliver(order.id, { ...proof, confirmed: undefined })).status, 400);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PICKED_UP');
  });

  it('records what the photo shows and that it checked out', async () => {
    const order = await pickedUpOrder();
    const res = await deliver(order.id, proof);
    assert.equal(res.status, 200);
    assert.equal(aiCalls, 1);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { trackingEvents: true } });
    assert.equal(updated.status, 'DELIVERED');
    assert.equal(updated.proofOfDeliveryType, 'PACKAGE_WITH_ID');
    assert.equal(updated.proofOfDeliveryCheck, 'PASSED');
    assert.match(updated.trackingEvents.find((e) => e.status === 'DELIVERED')!.note ?? '', /recipient's ID/);
  });

  it('still delivers a photo the check flags, and says why', async () => {
    aiAnswer = { status: 'flagged', reason: 'No ID card could be made out in the photo' };
    const order = await pickedUpOrder();
    assert.equal((await deliver(order.id, proof)).status, 200);
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { trackingEvents: true } });
    assert.equal(updated.status, 'DELIVERED');
    assert.equal(updated.proofOfDeliveryCheck, 'FLAGGED');
    assert.equal(updated.proofOfDeliveryNote, 'No ID card could be made out in the photo');
    assert.match(updated.trackingEvents.find((e) => e.status === 'DELIVERED')!.note ?? '', /flagged/);
  });

  it("doesn't check a photo that isn't stored on this server", async () => {
    const order = await pickedUpOrder();
    assert.equal((await deliver(order.id, { ...proof, proofOfDeliveryImageUrl: 'https://elsewhere.example/p.jpg' })).status, 200);
    assert.equal(aiCalls, 0);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).proofOfDeliveryCheck, 'NOT_CHECKED');
  });

  it("can't deliver a job that was accepted but never picked up", async () => {
    const order = await createOrder({ customerId: customer.id, warehouseId, status: 'READY_FOR_PICKUP', driverId: driver.id });
    const res = await deliver(order.id, proof);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /scan the label/);
    assert.equal(aiCalls, 0);
  });

  it('lists an accepted job as one to collect, with where to collect it', async () => {
    const order = await createOrder({ customerId: customer.id, warehouseId, status: 'READY_FOR_PICKUP', driverId: driver.id });
    const res = await api(server, '/drivers/me/deliveries', { token: driver.token });
    const row = res.body.inProgress.find((o: { id: string }) => o.id === order.id);
    assert.equal(row.status, 'READY_FOR_PICKUP');
    assert.ok(row.pickupFrom);
    assert.ok(row.pickupAddress);
  });
});
