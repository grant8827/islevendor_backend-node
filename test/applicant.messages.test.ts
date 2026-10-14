import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, closeSockets, createDriver, createShop, createUser, createWarehouse, nextEvent, openSocket, prisma, startServer, type TestServer, type TestUser } from './helpers.js';

// A business talking to a driver who applied to deliver for it.
describe('driver applications: interviews and messages', () => {
  let server: TestServer;

  before(async () => {
    server = await startServer();
  });
  afterEach(closeSockets);
  after(() => server.close());

  const call = (method: string, path: string, user: TestUser, body?: unknown) => api(server, path, { method, token: user.token, body });
  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  /** An approved driver who has applied to a new shop. */
  async function application() {
    const owner = await createUser('STORE');
    const shopId = await createShop(owner.id);
    const driver = await createDriver();
    const res = await call('POST', '/delivery-applications', driver, { shopId });
    assert.equal(res.status, 201);
    return { owner, shopId, driver, id: res.body.id as string };
  }

  const inbox = async (driver: TestUser, id: string) => ((await call('GET', '/delivery-applications/mine', driver)).body as any[]).find((a) => a.id === id);
  const businessList = async (owner: TestUser, shopId: string, id: string) =>
    ((await call('GET', `/shop/${shopId}/delivery-applications`, owner)).body as any[]).find((a) => a.id === id);

  describe('interviews', () => {
    it('lets the business invite the driver in person, and tells the driver', async () => {
      const a = await application();
      const socket = await openSocket(server, a.driver.token);
      const pushed = nextEvent(socket, ['APPLICATION_MESSAGE']);

      const res = await call('POST', `/delivery-applications/${a.id}/interview`, a.owner, { interviewAt: tomorrow(), location: '2 Test Road, Kingston', note: 'Bring your licence.' });
      assert.equal(res.status, 201);
      assert.equal(res.body.kind, 'INTERVIEW_SCHEDULED');
      assert.match(res.body.body, /^Test Shop would like to meet you in person on .+ at 2 Test Road, Kingston\.\n\nBring your licence\.$/);
      assert.deepEqual((await pushed).payload, { applicationId: a.id });

      const row = await inbox(a.driver, a.id);
      assert.equal(row.status, 'PENDING');
      assert.equal(row.interviewLocation, '2 Test Road, Kingston');
      assert.equal(row.unreadMessages, 1);
      assert.equal(row.lastMessage.kind, 'INTERVIEW_SCHEDULED');
    });

    it('says when an interview is moved', async () => {
      const a = await application();
      await call('POST', `/delivery-applications/${a.id}/interview`, a.owner, { interviewAt: tomorrow(), location: 'Front office' });
      const moved = await call('POST', `/delivery-applications/${a.id}/interview`, a.owner, { interviewAt: tomorrow(), location: 'Back office' });
      assert.match(moved.body.body, /moved your interview to .+ at Back office\./);
      assert.equal((await inbox(a.driver, a.id)).interviewLocation, 'Back office');
    });

    it('validates the time and place, and only once per pending application', async () => {
      const a = await application();
      const post = (body: object, user = a.owner) => call('POST', `/delivery-applications/${a.id}/interview`, user, body);
      assert.equal((await post({ interviewAt: new Date(Date.now() - 60_000).toISOString(), location: 'Office' })).status, 400);
      assert.equal((await post({ interviewAt: tomorrow(), location: '' })).status, 400);
      assert.equal((await post({ interviewAt: tomorrow(), location: 'Office' }, await createUser('STORE'))).status, 403);
      assert.equal((await post({ interviewAt: tomorrow(), location: 'Office' }, a.driver)).status, 403, 'drivers cannot schedule');

      await call('PATCH', `/delivery-applications/${a.id}`, a.owner, { status: 'APPROVED' });
      assert.equal((await post({ interviewAt: tomorrow(), location: 'Office' })).status, 409);
    });

    it("lets a warehouse's staff schedule too", async () => {
      const owner = await createUser('WAREHOUSE');
      const staff = await createUser('WAREHOUSE');
      const warehouseId = await createWarehouse(owner.id);
      await prisma.warehouseMember.create({ data: { warehouseId, userId: staff.id, role: 'STAFF' } });
      const driver = await createDriver();
      const { id } = (await call('POST', '/delivery-applications', driver, { warehouseId })).body;
      assert.equal((await call('POST', `/delivery-applications/${id}/interview`, staff, { interviewAt: tomorrow(), location: 'Dock 2' })).status, 201);
    });
  });

  describe('conversation', () => {
    it('lets the business ask for more information and the driver answer, with unread counts on both sides', async () => {
      const a = await application();
      const ask = await call('POST', `/delivery-applications/${a.id}/request-info`, a.owner, { message: 'Can you send a photo of your vehicle?' });
      assert.equal(ask.status, 201);
      assert.equal(ask.body.kind, 'INFO_REQUESTED');

      // Opening the conversation marks the business's messages read for the driver.
      const thread = await call('GET', `/delivery-applications/${a.id}/messages`, a.driver);
      assert.equal(thread.body.side, 'DRIVER');
      assert.equal(thread.body.application.businessName, 'Test Shop');
      assert.equal((await inbox(a.driver, a.id)).unreadMessages, 0);

      const reply = await call('POST', `/delivery-applications/${a.id}/messages`, a.driver, { body: 'Sent it to your WhatsApp.' });
      assert.equal(reply.status, 201);
      assert.equal(reply.body.senderSide, 'DRIVER');
      assert.equal((await businessList(a.owner, a.shopId, a.id)).unreadMessages, 1);

      const businessView = await call('GET', `/delivery-applications/${a.id}/messages`, a.owner);
      assert.equal(businessView.body.side, 'BUSINESS');
      assert.deepEqual(
        businessView.body.messages.map((m: any) => [m.senderSide, m.kind]),
        [
          ['BUSINESS', 'INFO_REQUESTED'],
          ['DRIVER', 'MESSAGE'],
        ],
      );
      assert.equal((await businessList(a.owner, a.shopId, a.id)).unreadMessages, 0);
    });

    it('pushes a driver’s reply to the business dashboard', async () => {
      const a = await application();
      const dashboard = await openSocket(server, a.owner.token);
      await dashboard.timeout(3000).emitWithAck('shop:join', a.shopId);
      const pushed = nextEvent(dashboard, ['APPLICATION_MESSAGE']);
      await call('POST', `/delivery-applications/${a.id}/messages`, a.driver, { body: 'Hello!' });
      assert.deepEqual((await pushed).payload, { applicationId: a.id });
    });

    it('is private to the business and the driver', async () => {
      const a = await application();
      for (const outsider of [await createDriver(), await createUser('STORE'), await createUser('CUSTOMER')]) {
        assert.equal((await call('GET', `/delivery-applications/${a.id}/messages`, outsider)).status, 403);
        assert.equal((await call('POST', `/delivery-applications/${a.id}/messages`, outsider, { body: 'hi' })).status, 403);
      }
      assert.equal((await call('GET', '/delivery-applications/00000000-0000-0000-0000-000000000000/messages', a.driver)).status, 404);
    });
  });

  describe('decisions', () => {
    it('tells the driver about an approval, with the business’s note', async () => {
      const a = await application();
      await call('PATCH', `/delivery-applications/${a.id}`, a.owner, { status: 'APPROVED', message: 'See you Monday at 8.' });
      const last = (await inbox(a.driver, a.id)).lastMessage;
      assert.equal(last.kind, 'DECISION');
      assert.equal(last.body, "Test Shop approved you to deliver for them. You'll get their pickups while you're online.\n\nSee you Monday at 8.");
    });

    it('closes the conversation after a rejection', async () => {
      const a = await application();
      await call('PATCH', `/delivery-applications/${a.id}`, a.owner, { status: 'REJECTED' });
      assert.match((await inbox(a.driver, a.id)).lastMessage.body, /decided not to go ahead/);
      assert.equal((await call('POST', `/delivery-applications/${a.id}/messages`, a.driver, { body: 'Why?' })).status, 409);
    });
  });
});
