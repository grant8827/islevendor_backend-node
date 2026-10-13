import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  api,
  createDriver,
  createOrder,
  createResellerStore,
  createUser,
  createWarehouse,
  prisma,
  startServer,
  type TestServer,
  type TestUser,
} from './helpers.js';
import { createAdminAccount } from '../src/lib/adminProvisioning.js';
import { signAuthToken } from '../src/middleware/auth.js';

describe('superadmin console API', () => {
  let server: TestServer;
  let admin: TestUser, customer: TestUser, warehouseOwner: TestUser, reseller: TestUser, driver: TestUser;
  let driverProfileId: string, warehouseId: string, resellerStoreId: string;

  before(async () => {
    server = await startServer();
    [admin, customer, warehouseOwner, reseller] = await Promise.all([
      createUser('ADMIN'),
      createUser('CUSTOMER'),
      createUser('WAREHOUSE'),
      createUser('RESELLER'),
    ]);
    driver = await createDriver({ isKycApproved: false, applicantStatus: 'PENDING_REVIEW' });
    driverProfileId = (
      await prisma.driverProfile.update({
        where: { userId: driver.id },
        data: {
          homeParish: 'St. Andrew',
          slaAcceptedAt: new Date(),
          accountNumber: '000123456789',
          licenseImageUrl: `private-kyc://${randomUUID()}.png`,
          licenseVerificationStatus: 'NAME_MISMATCH',
          insuranceVerificationStatus: 'VERIFIED',
        },
      })
    ).id;
    warehouseId = await createWarehouse(warehouseOwner.id);
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { applicantStatus: 'PENDING_REVIEW' } });
    resellerStoreId = await createResellerStore(reseller.id);
  });

  after(() => server.close());

  const get = (path: string, user?: TestUser) => api(server, path, { token: user?.token });
  const decide = (type: string, id: string, body: unknown, user: TestUser = admin) =>
    api(server, `/v1/onboarding/${type}/${id}/decision`, { method: 'POST', token: user.token, body });

  describe('access', () => {
    const routes = ['/admin/overview', '/admin/applicants', '/admin/users', '/admin/orders', '/admin/audit-events'];

    it('is closed to every non-admin role and to signed-out requests', async () => {
      for (const route of [...routes, `/admin/applicants/driver/${driverProfileId}`]) {
        assert.equal((await get(route)).status, 401, `${route} unauthenticated`);
        for (const user of [customer, warehouseOwner, reseller, driver]) {
          assert.equal((await get(route, user)).status, 403, `${route} as ${user.role}`);
        }
      }
    });

    it('is closed to a token that claims ADMIN for an account that is not one', async () => {
      const stale: TestUser = { ...customer, token: signAuthToken({ sub: customer.id, role: 'ADMIN' }) };
      const gone: TestUser = { ...customer, token: signAuthToken({ sub: randomUUID(), role: 'ADMIN' }) };
      for (const user of [stale, gone]) {
        for (const route of routes) assert.equal((await get(route, user)).status, 403, route);
        assert.equal((await decide('driver', driverProfileId, { decision: 'APPROVED' }, user)).status, 403);
      }
      assert.equal((await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } })).applicantStatus, 'PENDING_REVIEW');
    });

    it('cannot be obtained by registering as an administrator', async () => {
      const res = await api(server, '/auth/register', {
        method: 'POST',
        body: { email: `${randomUUID()}@islevendor.test`, password: 'Passw0rd!', fullName: 'Mallory', phoneNumber: '8760000000', role: 'ADMIN' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('provisioning', () => {
    it('creates an administrator who can sign in, and audits the creation', async () => {
      const email = `Admin-${randomUUID()}@islevendor.test`;
      const { id, password } = await createAdminAccount({ email, fullName: 'New Admin', phoneNumber: '8765550000' }, 'test-operator');

      const login = await api(server, '/auth/login', { method: 'POST', body: { email, password } });
      assert.equal(login.status, 200);
      assert.equal(login.body.user.role, 'ADMIN');
      assert.equal((await api(server, '/admin/overview', { token: login.body.token })).status, 200);

      const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'admin.created', targetId: id } });
      assert.deepEqual(event.metadata, { via: 'cli', provisionedBy: 'test-operator', email: email.toLowerCase() });
      assert.ok(!JSON.stringify(event).includes(password), 'the password must never reach the audit log');

      await assert.rejects(createAdminAccount({ email, fullName: 'Dup', phoneNumber: '1' }, 'test-operator'), /already exists/);
    });
  });

  describe('overview', () => {
    it('counts pending applicants, users and orders', async () => {
      const res = await get('/admin/overview', admin);
      assert.equal(res.status, 200);
      assert.ok(res.body.pendingApplicants.driver >= 1);
      assert.ok(res.body.pendingApplicants.warehouse >= 1);
      assert.ok(res.body.usersByRole.ADMIN >= 1);
      assert.equal(typeof res.body.ordersByStatus, 'object');
    });
  });

  describe('applicants', () => {
    it('lists pending applicants of every type, with their document flags', async () => {
      const res = await get('/admin/applicants', admin);
      assert.equal(res.status, 200);

      const mine = res.body.find((a: any) => a.id === driverProfileId);
      assert.equal(mine.type, 'driver');
      assert.equal(mine.name, 'Test DRIVER');
      assert.equal(mine.parish, 'St. Andrew');
      assert.deepEqual(mine.flags, ['License: name mismatch']);
      assert.ok(res.body.some((a: any) => a.id === warehouseId && a.type === 'warehouse'));
      // The reseller store was created already-approved, so it isn't pending.
      assert.ok(!res.body.some((a: any) => a.id === resellerStoreId));
    });

    it('filters by type and status', async () => {
      const drivers = (await get('/admin/applicants?type=driver', admin)).body;
      assert.ok(drivers.length >= 1 && drivers.every((a: any) => a.type === 'driver'));

      const approved = (await get('/admin/applicants?status=APPROVED&type=reseller', admin)).body;
      assert.ok(approved.some((a: any) => a.id === resellerStoreId));

      assert.equal((await get('/admin/applicants?status=BOGUS', admin)).status, 400);
    });

    it('shows the full application without document references or the full account number', async () => {
      const res = await get(`/admin/applicants/driver/${driverProfileId}`, admin);
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, (await prisma.user.findUniqueOrThrow({ where: { id: driver.id } })).email);
      assert.equal(res.body.profile.homeParish, 'St. Andrew');
      assert.equal(res.body.profile.accountNumber, '••••6789');
      assert.deepEqual(
        res.body.documents.find((d: any) => d.kind === 'license'),
        { kind: 'license', onFile: true },
      );

      const raw = JSON.stringify(res.body);
      assert.ok(!raw.includes('private-kyc://'), 'storage references must not reach the console');
      assert.ok(!raw.includes('000123456789'));
      assert.ok(!raw.includes('passwordHash'));

      assert.equal((await get(`/admin/applicants/driver/${randomUUID()}`, admin)).status, 404);
    });

    it('requires a reason to reject, and none to approve', async () => {
      assert.equal((await decide('driver', driverProfileId, { decision: 'REJECTED' })).status, 400);
      assert.equal((await decide('driver', driverProfileId, { decision: 'MAYBE' })).status, 400);
      assert.equal((await decide('driver', randomUUID(), { decision: 'APPROVED' })).status, 404);
      assert.equal((await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } })).applicantStatus, 'PENDING_REVIEW');
    });

    it('makes a driver eligible for jobs on approval and ineligible on rejection', async () => {
      const profile = () => prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } });

      assert.equal((await decide('driver', driverProfileId, { decision: 'APPROVED' })).status, 200);
      assert.deepEqual([(await profile()).applicantStatus, (await profile()).isKycApproved], ['APPROVED', true]);

      assert.equal((await decide('driver', driverProfileId, { decision: 'REJECTED', reason: 'Licence name does not match' })).status, 200);
      assert.deepEqual([(await profile()).applicantStatus, (await profile()).isKycApproved], ['REJECTED', false]);
    });

    it('records each decision with who made it and why, and shows it on the application', async () => {
      const res = await get(`/admin/applicants/driver/${driverProfileId}`, admin);
      const decisions = res.body.history.filter((e: any) => e.action === 'applicant.decision');
      assert.equal(decisions.length, 2);
      // Newest first.
      assert.deepEqual(decisions[0].metadata, { decision: 'REJECTED', reason: 'Licence name does not match' });
      assert.deepEqual(decisions[1].metadata, { decision: 'APPROVED' });
      assert.equal(decisions[0].actorId, admin.id);
      assert.equal(decisions[0].actor.fullName, 'Test ADMIN');
    });
  });

  describe('users, orders and audit log', () => {
    it('searches users by name or email and filters by role', async () => {
      const email = (await prisma.user.findUniqueOrThrow({ where: { id: reseller.id } })).email;
      const byEmail = await get(`/admin/users?q=${encodeURIComponent(email.toUpperCase())}`, admin);
      assert.equal(byEmail.status, 200);
      assert.deepEqual(
        byEmail.body.users.map((u: any) => u.id),
        [reseller.id],
      );
      assert.ok(!('passwordHash' in byEmail.body.users[0]));

      const admins = (await get('/admin/users?role=ADMIN', admin)).body;
      assert.ok(admins.total >= 1 && admins.users.every((u: any) => u.role === 'ADMIN'));
      assert.equal((await get('/admin/users?role=WIZARD', admin)).status, 400);
    });

    it('finds an order by the short number shown in the UI', async () => {
      const order = await createOrder({ customerId: customer.id, warehouseId, resellerStoreId, status: 'PACKING' });
      const res = await get(`/admin/orders?q=${order.id.slice(0, 8).toUpperCase()}`, admin);
      assert.equal(res.status, 200);
      assert.ok(res.body.orders.some((o: any) => o.id === order.id && o.warehouse.name === 'Test Warehouse' && o.customer.fullName === 'Test CUSTOMER'));

      const packing = (await get('/admin/orders?status=PACKING', admin)).body;
      assert.ok(packing.orders.every((o: any) => o.status === 'PACKING'));
      assert.equal((await get("/admin/orders?q=' OR 1=1 --", admin)).status, 400);
    });

    it('lists audit events newest first, with the acting admin', async () => {
      const res = await get('/admin/audit-events?action=applicant.decision', admin);
      assert.equal(res.status, 200);
      assert.ok(res.body.total >= 2);
      assert.ok(res.body.events.every((e: any) => e.action === 'applicant.decision'));
      const times = res.body.events.map((e: any) => Date.parse(e.createdAt));
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
    });
  });
});
