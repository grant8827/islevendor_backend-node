import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { api, createLedgerAccount, createShop, createUser, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { addBusinessDays } from '../src/lib/platformSettings.js';
import { env } from '../src/env.js';

// Telling people when a withdrawal should reach their bank.
describe('payout timing', () => {
  let server: TestServer;
  let admin: TestUser;

  before(async () => {
    server = await startServer();
    admin = await createUser('ADMIN');
  });
  after(async () => {
    await api(server, '/admin/settings/payouts', { method: 'PUT', token: admin.token, body: { minBusinessDays: 2, maxBusinessDays: 5 } });
    await server.close();
  });

  const call = (method: string, path: string, user: TestUser, body?: unknown) => api(server, path, { method, token: user.token, body });
  const day = (d: Date) => d.toISOString().slice(0, 10);

  it('counts business days in Jamaica time, skipping weekends', () => {
    // Friday 16 Oct 2026, 10am in Jamaica (15:00 UTC).
    const friday = new Date('2026-10-16T15:00:00Z');
    assert.equal(day(addBusinessDays(friday, 1)), '2026-10-19', 'Monday');
    assert.equal(day(addBusinessDays(friday, 5)), '2026-10-23', 'the next Friday');
    // 11pm Friday in Jamaica is already Saturday in UTC — still counts from Friday.
    assert.equal(day(addBusinessDays(new Date('2026-10-17T04:00:00Z'), 1)), '2026-10-19');
    // From a Saturday, the first business day is still Monday.
    assert.equal(day(addBusinessDays(new Date('2026-10-17T15:00:00Z'), 1)), '2026-10-19');
  });

  it('is set by an admin, audited, and shown to anyone signed in', async () => {
    const seller = await createUser('STORE');
    assert.equal((await call('PUT', '/admin/settings/payouts', seller, { minBusinessDays: 1, maxBusinessDays: 3 })).status, 403);
    assert.equal((await call('PUT', '/admin/settings/payouts', admin, { minBusinessDays: 4, maxBusinessDays: 2 })).status, 400);

    assert.equal((await call('PUT', '/admin/settings/payouts', admin, { minBusinessDays: 1, maxBusinessDays: 3 })).status, 200);
    assert.deepEqual((await call('GET', '/ledger/payout-timing', seller)).body, { minBusinessDays: 1, maxBusinessDays: 3 });

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'settings.payout_timing_changed' }, orderBy: { createdAt: 'desc' } });
    assert.deepEqual((event.metadata as any).after, { minBusinessDays: 1, maxBusinessDays: 3 });
  });

  it('stamps each withdrawal with the date it should arrive by', async () => {
    await call('PUT', '/admin/settings/payouts', admin, { minBusinessDays: 2, maxBusinessDays: 4 });
    const owner = await createUser('STORE');
    await createShop(owner.id);
    const account = await createLedgerAccount(owner.id, 'STORE');
    // One delivered sale's worth, already available.
    const order = await prisma.order.create({
      data: {
        customerId: (await createUser('CUSTOMER')).id,
        shopId: (await prisma.shop.findFirstOrThrow({ where: { userId: owner.id } })).id,
        totalPaidJmd: 1000,
        wholesaleTotalJmd: 0,
        resellerMarginJmd: 1000,
        driverFeeJmd: 0,
        platformCommissionJmd: 0,
        deliveryAddress: 'x',
        status: 'DELIVERED',
      },
    });
    await prisma.ledgerTransaction.create({ data: { orderId: order.id, recipientAccountId: account.id, amountJmd: 1000, escrowState: 'AVAILABLE' } });
    await prisma.ledgerAccount.update({ where: { id: account.id }, data: { availableBalanceJmd: 1000 } });

    env.ENABLE_WITHDRAWALS = true;
    try {
      const res = await call('POST', '/ledger/withdraw', owner);
      assert.equal(res.status, 201);
      assert.equal(res.body[0].expectedBy.slice(0, 10), day(addBusinessDays(new Date(), 4)));
    } finally {
      env.ENABLE_WITHDRAWALS = false;
    }
  });
});
