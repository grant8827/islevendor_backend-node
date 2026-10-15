import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { api, closeSockets, createUser, openSocket, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { signAuthToken } from '../src/middleware/auth.js';
import { revokeUserSessions } from '../src/lib/sessions.js';

describe('session revocation', () => {
  let server: TestServer;
  let admin: TestUser;

  before(async () => {
    server = await startServer();
    admin = await createUser('ADMIN');
  });
  afterEach(closeSockets);
  after(() => server.close());

  const me = (token: string) => api(server, '/auth/me', { token });

  /** A real account with a known password, signed in on two devices. */
  async function accountOnTwoDevices() {
    const email = `${randomUUID()}@islevendor.test`;
    const password = 'Passw0rd!';
    const user = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 4), fullName: 'Two Devices', phoneNumber: '8760000000', role: 'CUSTOMER' },
    });
    const login = async (pw = password) => (await api(server, '/auth/login', { method: 'POST', body: { email, password: pw } })).body.token as string;
    return { user, email, password, login, phone: await login(), laptop: await login() };
  }

  it('accepts tokens issued before revocation existed, and rejects one for a deleted account', async () => {
    const user = await createUser('CUSTOMER');
    assert.equal((await me(signAuthToken({ sub: user.id, role: 'CUSTOMER' }))).status, 200);
    assert.equal((await me(signAuthToken({ sub: randomUUID(), role: 'CUSTOMER' }))).status, 401);
    assert.equal((await me('not-a-token')).status, 401);
  });

  it('signs every other device out on a password change, and keeps this one signed in', async () => {
    const { phone, laptop, password, login } = await accountOnTwoDevices();
    assert.equal((await me(phone)).status, 200);

    const res = await api(server, '/auth/password', {
      method: 'PATCH',
      token: laptop,
      body: { currentPassword: password, newPassword: 'N3wPassw0rd!' },
    });
    assert.equal(res.status, 200);

    assert.equal((await me(phone)).status, 401, 'the other device must be signed out');
    assert.equal((await me(laptop)).status, 401, 'the old token on this device is dead too');
    assert.equal((await me(res.body.token)).status, 200, 'the replacement token works');
    assert.equal((await me(await login('N3wPassw0rd!'))).status, 200);
  });

  it('does not revoke anything when the password change is rejected', async () => {
    const { phone, laptop } = await accountOnTwoDevices();
    const res = await api(server, '/auth/password', { method: 'PATCH', token: laptop, body: { currentPassword: 'wrong', newPassword: 'N3wPassw0rd!' } });
    assert.equal(res.status, 400);
    assert.equal((await me(phone)).status, 200);
  });

  it('lets a user sign out everywhere', async () => {
    const { phone, laptop, login } = await accountOnTwoDevices();
    assert.equal((await api(server, '/auth/sessions/revoke', { method: 'POST', token: phone })).status, 204);

    assert.equal((await me(phone)).status, 401);
    assert.equal((await me(laptop)).status, 401);
    assert.equal((await me(await login())).status, 200, 'signing in again works');
  });

  it('lets an admin sign a user out, with a reason, and audits it', async () => {
    const { user, phone } = await accountOnTwoDevices();
    const revoke = (token: string, body?: unknown) => api(server, `/admin/users/${user.id}/revoke-sessions`, { method: 'POST', token, body });

    assert.equal((await revoke(phone, { reason: 'x' })).status, 403, 'not an admin');
    assert.equal((await revoke(admin.token, {})).status, 400, 'reason required');
    assert.equal((await me(phone)).status, 200);

    assert.equal((await revoke(admin.token, { reason: 'Reported phishing' })).status, 204);
    assert.equal((await me(phone)).status, 401);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'user.sessions_revoked', targetId: user.id } });
    assert.equal(event.actorId, admin.id);
    assert.deepEqual(event.metadata, { reason: 'Reported phishing' });

    assert.equal((await api(server, `/admin/users/${randomUUID()}/revoke-sessions`, { method: 'POST', token: admin.token, body: { reason: 'x' } })).status, 404);
  });

  it('locks a revoked admin out of the console immediately', async () => {
    const other = await createUser('ADMIN');
    assert.equal((await api(server, '/admin/overview', { token: other.token })).status, 200);
    await revokeUserSessions(other.id);
    assert.equal((await api(server, '/admin/overview', { token: other.token })).status, 401);
  });

  it('drops open sockets and refuses new ones on a revoked token', async () => {
    const user = await createUser('WAREHOUSE');
    const socket = await openSocket(server, user.token);
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));

    await revokeUserSessions(user.id);
    assert.equal(await disconnected, 'io server disconnect');
    await assert.rejects(openSocket(server, user.token), /Invalid auth token/);
  });
});
