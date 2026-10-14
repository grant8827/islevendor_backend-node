import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { api, createLedgerAccount, createShop, createUser, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { env } from '../src/env.js';
import { decryptField, encryptField } from '../src/lib/crypto.js';

// ── A fake WiPay withdrawal API ──────────────────────────────────────────────
// Records every request and answers the way the test tells it to. No request
// ever leaves this machine.

interface FakeWithdrawal {
  transaction_id: string;
  reference: string;
  status: number;
  status_description: string;
  fee_amount: string;
  amount: string;
  data: string;
  created_at: string;
}

const fake = {
  /** What POST /withdrawals does next: 'ok', 'reject' (400), 'lost' (created, but 503 back), 'down' (503, not created). */
  mode: 'ok' as 'ok' | 'reject' | 'lost' | 'down',
  withdrawals: new Map<string, FakeWithdrawal>(),
  creates: [] as { headers: http.IncomingHttpHeaders; body: any }[],
  retrieves: 0,
  reset() {
    this.mode = 'ok';
    this.withdrawals.clear();
    this.creates = [];
    this.retrieves = 0;
  },
  setStatus(transactionId: string, status: number, description: string) {
    Object.assign(this.withdrawals.get(transactionId)!, { status, status_description: description });
  },
};

function startFakeWiPay(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-wapi-key'] !== 'test-wapi-key') return send(403, { message: 'Forbidden' });
      const url = new URL(req.url!, 'http://fake');

      if (req.method === 'POST' && url.pathname === '/wapi/withdrawals') {
        const body = JSON.parse(raw);
        fake.creates.push({ headers: req.headers, body });
        if (fake.mode === 'reject') return send(400, { message: 'The bank branch is invalid.' });
        if (fake.mode === 'down') return send(503, { message: 'Unavailable' });
        const w: FakeWithdrawal = {
          transaction_id: `WD-${randomUUID().slice(0, 8)}`,
          reference: randomUUID(),
          status: 0,
          status_description: 'Not On ACH File',
          fee_amount: '150.00',
          amount: Number(body.amount).toFixed(2),
          data: body.data,
          created_at: new Date().toISOString(),
        };
        fake.withdrawals.set(w.transaction_id, w);
        if (fake.mode === 'lost') return send(503, { message: 'Gateway timeout' });
        return send(201, { message: 'Created', data: { data: w.data, reference: w.reference, transaction_id: w.transaction_id } });
      }
      if (req.method === 'GET' && url.pathname === '/wapi/withdrawals') {
        const amount = url.searchParams.get('amount_min');
        return send(200, { data: { data: [...fake.withdrawals.values()].filter((w) => !amount || Number(w.amount) === Number(amount)), meta: {} } });
      }
      const match = url.pathname.match(/^\/wapi\/withdrawals\/(.+)$/);
      if (req.method === 'GET' && match) {
        fake.retrieves += 1;
        const w = fake.withdrawals.get(decodeURIComponent(match[1]));
        return w ? send(200, { data: w }) : send(400, { message: 'Not found' });
      }
      send(404, { message: 'No route' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ url: `http://localhost:${(server.address() as AddressInfo).port}/wapi`, close: () => server.close() })),
  );
}

describe('automated WiPay payouts', () => {
  let server: TestServer;
  let wipay: Awaited<ReturnType<typeof startFakeWiPay>>;
  let admin: TestUser;
  const PASSWORD = 'Passw0rd!';
  const SECRET = 'test-webhook-secret';

  before(async () => {
    server = await startServer();
    wipay = await startFakeWiPay();
    admin = await createUser('ADMIN');
    Object.assign(env, {
      ENABLE_WITHDRAWALS: true,
      ENABLE_AUTOMATED_PAYOUTS: true,
      WIPAY_PAYOUT_API_URL: wipay.url,
      WIPAY_PAYOUT_API_KEY: 'test-wapi-key',
      WIPAY_PAYOUT_WEBHOOK_SECRET: SECRET,
    });
  });
  beforeEach(() => fake.reset());
  after(async () => {
    Object.assign(env, { ENABLE_WITHDRAWALS: false, ENABLE_AUTOMATED_PAYOUTS: false, WIPAY_PAYOUT_API_URL: undefined, WIPAY_PAYOUT_API_KEY: undefined, WIPAY_PAYOUT_WEBHOOK_SECRET: undefined });
    wipay.close();
    await server.close();
  });

  const call = (method: string, path: string, user?: TestUser, body?: unknown) => api(server, path, { method, token: user?.token, body });

  const completeBankDetails = {
    method: 'BANK',
    bankName: 'National Commercial Bank',
    bankBranch: 'Half Way Tree',
    bankAccountType: 'SAVINGS',
    accountNumber: '404-123-456',
    nameInBank: 'Andrea Brown',
    idType: 'DRIVER_PERMIT',
    idNumber: '123456789',
    email: 'andrea@example.com',
    phone: '876-555-1234',
    currentPassword: PASSWORD,
  };

  /** A store owner with a password, J$5,000 available, and (by default) complete bank details. */
  async function sellerWithFunds(details: object | null = completeBankDetails) {
    const owner = await createUser('STORE');
    await prisma.user.update({ where: { id: owner.id }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    const shopId = await createShop(owner.id);
    const account = await createLedgerAccount(owner.id, 'STORE');
    const order = await prisma.order.create({
      data: { customerId: admin.id, shopId, totalPaidJmd: 5000, wholesaleTotalJmd: 0, resellerMarginJmd: 5000, driverFeeJmd: 0, platformCommissionJmd: 0, deliveryAddress: 'x', status: 'DELIVERED' },
    });
    await prisma.ledgerTransaction.create({ data: { orderId: order.id, recipientAccountId: account.id, amountJmd: 5000, escrowState: 'AVAILABLE' } });
    await prisma.ledgerAccount.update({ where: { id: account.id }, data: { availableBalanceJmd: 5000 } });
    if (details) assert.equal((await call('PUT', '/ledger/payout-account', owner, details)).status, 200);
    return { owner, ledgerAccountId: account.id };
  }

  /** A seller's withdrawal request, approved by an admin. */
  async function approvedPayout(details?: object | null) {
    const seller = await sellerWithFunds(details);
    const [payout] = (await call('POST', '/ledger/withdraw', seller.owner)).body;
    assert.equal((await call('POST', `/admin/payouts/${payout.id}/approve`, admin)).status, 200);
    return { ...seller, payoutId: payout.id as string };
  }

  const available = async (ledgerAccountId: string) => Number((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: ledgerAccountId } })).availableBalanceJmd);
  const payoutRow = (id: string) => prisma.payout.findUniqueOrThrow({ where: { id } });
  const send = (id: string) => call('POST', `/admin/payouts/${id}/send-wipay`, admin);
  const check = (id: string) => call('POST', `/admin/payouts/${id}/check-wipay`, admin);

  describe('payout details', () => {
    it('stores account and ID numbers encrypted and only ever shows the last four digits', async () => {
      const { owner } = await sellerWithFunds();
      const view = (await call('GET', '/ledger/payout-account', owner)).body.account;
      assert.equal(view.accountNumber, '••••3456');
      assert.equal(view.hasIdNumber, true);
      assert.equal(view.phone, '+18765551234');
      assert.equal(view.readyForAutomaticPayout, true);
      assert.ok(!JSON.stringify(view).includes('404123456'));

      const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { userId: owner.id } });
      assert.ok(!JSON.stringify(row).includes('404123456') && !JSON.stringify(row).includes('123456789'), 'no plaintext numbers in the database');
      assert.equal(decryptField(row.accountNumberEncrypted!), '404123456');

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'payout_account.updated', targetId: owner.id } });
      assert.ok(!JSON.stringify(audit.metadata).includes('404123456'));
    });

    it('needs the current password, a bank WiPay knows, and a valid ID', async () => {
      const { owner } = await sellerWithFunds(null);
      const put = (changes: object) => call('PUT', '/ledger/payout-account', owner, { ...completeBankDetails, ...changes });
      assert.equal((await put({ currentPassword: 'wrong' })).status, 400);
      assert.equal((await put({ bankName: 'Bank of Nowhere' })).status, 400);
      assert.equal((await put({ idNumber: '12AB' })).status, 400);
      assert.equal((await put({ phone: '12' })).status, 400);
      assert.equal(await prisma.payoutAccount.count({ where: { userId: owner.id } }), 0);
    });

    it('lets manual payouts go ahead without ID details, but not automatic ones', async () => {
      const { idType: _t, idNumber: _n, ...withoutId } = completeBankDetails;
      const { payoutId } = await approvedPayout(withoutId);
      const res = await send(payoutId);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /ID type and number/);
      assert.equal(fake.creates.length, 0);
    });

    it('rejects tampered ciphertext', () => {
      const stored = encryptField('secret');
      const tampered = stored.slice(0, -4) + (stored.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      assert.throws(() => decryptField(tampered));
    });
  });

  describe('sending', () => {
    it('sends an approved payout to WiPay as a sub_banked withdrawal, and waits for WiPay to complete it', async () => {
      const { payoutId, ledgerAccountId } = await approvedPayout();
      const res = await send(payoutId);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'PROCESSING', 'accepted by WiPay is not paid');

      const [{ headers, body }] = fake.creates;
      assert.equal(headers['x-wapi-key'], 'test-wapi-key');
      assert.deepEqual(
        { ...body, data: JSON.parse(body.data) },
        {
          withdrawal_type: 'sub_banked',
          currency: 'JMD',
          amount: 5000,
          email: 'andrea@example.com',
          phone: '+18765551234',
          bank_name: 'National Commercial Bank',
          bank_account: '404123456',
          bank_account_type: 'savings',
          bank_branch: 'Half Way Tree',
          name_in_bank: 'Andrea Brown',
          id_type: 'driver_permit',
          id_number: '123456789',
          data: { payoutId, submissionKey: (await payoutRow(payoutId)).submissionKey },
        },
      );

      const transactionId = (await payoutRow(payoutId)).providerTransactionId!;
      fake.setStatus(transactionId, 1, 'Being Processed By Bank');
      assert.equal((await check(payoutId)).body.status, 'PROCESSING');
      fake.setStatus(transactionId, 2, 'Transaction Completed');
      const paid = await check(payoutId);
      assert.equal(paid.body.status, 'PAID');
      assert.equal(Number(paid.body.providerFeeJmd), 150);
      assert.equal(await available(ledgerAccountId), 0, 'the money stays paid out');
    });

    it('never sends a payout twice, even when asked twice at once', async () => {
      const { payoutId } = await approvedPayout();
      const results = await Promise.all([send(payoutId), send(payoutId), send(payoutId)]);
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.equal(fake.creates.length, 1);
      assert.equal((await send(payoutId)).status, 409);
    });

    it('needs approval first, and is off unless the switch is on', async () => {
      const seller = await sellerWithFunds();
      const [payout] = (await call('POST', '/ledger/withdraw', seller.owner)).body;
      assert.equal((await send(payout.id)).status, 409, 'not approved yet');

      await call('POST', `/admin/payouts/${payout.id}/approve`, admin);
      env.ENABLE_AUTOMATED_PAYOUTS = false;
      try {
        assert.equal((await send(payout.id)).status, 503);
      } finally {
        env.ENABLE_AUTOMATED_PAYOUTS = true;
      }
      // Manual payment still works from APPROVED.
      const manual = await call('PATCH', `/admin/payouts/${payout.id}`, admin, { status: 'PAID', reference: 'NCB-1' });
      assert.equal(manual.body.status, 'PAID');
      assert.equal(manual.body.channel, 'MANUAL');
      assert.equal(fake.creates.length, 0);
    });

    it('returns a refused payout to APPROVED with the reason, to fix and send again', async () => {
      const { payoutId } = await approvedPayout();
      fake.mode = 'reject';
      const res = await send(payoutId);
      assert.equal(res.status, 422);
      assert.match(res.body.error, /branch is invalid/);
      const row = await payoutRow(payoutId);
      assert.deepEqual([row.status, row.submissionKey], ['APPROVED', null]);

      fake.mode = 'ok';
      assert.equal((await send(payoutId)).body.status, 'PROCESSING');
    });

    it('returns the money when WiPay sends it back', async () => {
      const { payoutId, ledgerAccountId } = await approvedPayout();
      await send(payoutId);
      fake.setStatus((await payoutRow(payoutId)).providerTransactionId!, 5, 'Refunded To Account');
      const res = await check(payoutId);
      assert.equal(res.body.status, 'FAILED');
      assert.equal(await available(ledgerAccountId), 5000);
    });

    it("can't be marked paid by hand once it's with WiPay", async () => {
      const { payoutId } = await approvedPayout();
      await send(payoutId);
      const res = await call('PATCH', `/admin/payouts/${payoutId}`, admin, { status: 'PAID', reference: 'x' });
      assert.equal(res.status, 409);
    });
  });

  describe('when WiPay doesn’t answer', () => {
    it('finds a submission WiPay accepted but never confirmed, instead of sending it again', async () => {
      const { payoutId } = await approvedPayout();
      fake.mode = 'lost';
      const res = await send(payoutId);
      assert.equal(res.status, 504);
      assert.equal((await payoutRow(payoutId)).status, 'SUBMITTED');
      assert.equal((await send(payoutId)).status, 409, 'no resend while uncertain');

      fake.mode = 'ok';
      const checked = await check(payoutId);
      assert.equal(checked.body.status, 'PROCESSING');
      assert.ok(checked.body.providerTransactionId);
      assert.equal(fake.creates.length, 1, 'found in WiPay’s records — never sent twice');
    });

    it('only releases it to be sent again once WiPay has had time to show it and doesn’t', async () => {
      const { payoutId } = await approvedPayout();
      fake.mode = 'down';
      await send(payoutId);

      assert.equal((await check(payoutId)).status, 409, 'too soon to conclude');
      await prisma.payout.update({ where: { id: payoutId }, data: { submittedAt: new Date(Date.now() - 20 * 60 * 1000) } });
      const released = await check(payoutId);
      assert.equal(released.body.status, 'APPROVED');

      fake.mode = 'ok';
      assert.equal((await send(payoutId)).body.status, 'PROCESSING');
      assert.equal(fake.withdrawals.size, 1);
    });
  });

  describe('notifications', () => {
    const notify = (body: object, opts: { secret?: string; ageSeconds?: number } = {}) => {
      const raw = JSON.stringify(body);
      const timestamp = Math.floor(Date.now() / 1000) - (opts.ageSeconds ?? 0);
      const signature = crypto.createHmac('sha256', opts.secret ?? SECRET).update(`${timestamp}.${raw}`).digest('hex');
      return fetch(`${server.baseUrl}/api/ledger/webhooks/wipay-payouts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WiPay-Webhook-Signature': `sha256=${signature}`,
          'X-WiPay-Webhook-Timestamp': String(timestamp),
          'X-WiPay-Webhook-Id': (body as { id: string }).id,
        },
        body: raw,
      });
    };

    it('refuses an unsigned, wrongly signed or stale notification', async () => {
      const event = { id: randomUUID(), event: 'withdrawal.updated', data: {} };
      assert.equal((await notify(event, { secret: 'wrong' })).status, 400);
      assert.equal((await notify(event, { ageSeconds: 600 })).status, 400);
      const unsigned = await fetch(`${server.baseUrl}/api/ledger/webhooks/wipay-payouts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      assert.equal(unsigned.status, 400);
      assert.equal(await prisma.payoutWebhookEvent.count({ where: { providerEventId: event.id } }), 0);
    });

    it("confirms with WiPay before applying, and handles each event once", async () => {
      const { payoutId } = await approvedPayout();
      await send(payoutId);
      const transactionId = (await payoutRow(payoutId)).providerTransactionId!;
      fake.setStatus(transactionId, 2, 'Transaction Completed');

      // The payload's own status is ignored — WiPay's record decides.
      const event = { id: randomUUID(), event: 'withdrawal.updated', data: { transaction_id: transactionId, status: 5 } };
      const first = await notify(event);
      assert.equal(first.status, 200);
      assert.equal((await payoutRow(payoutId)).status, 'PAID');
      const retrievesAfterFirst = fake.retrieves;

      const again = await notify(event);
      assert.deepEqual(await again.json(), { duplicate: true });
      assert.equal(fake.retrieves, retrievesAfterFirst, 'a redelivery does nothing');
    });

    it('records notifications it can’t match', async () => {
      const event = { id: randomUUID(), event: 'withdrawal.updated', data: { transaction_id: 'WD-unknown' } };
      assert.equal((await notify(event)).status, 200);
      assert.equal((await prisma.payoutWebhookEvent.findUniqueOrThrow({ where: { providerEventId: event.id } })).outcome, 'unmatched');
    });
  });

  describe('start-up safeguards', () => {
    const boot = (vars: Record<string, string>) =>
      spawnSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/env.ts').then(() => process.exit(0), () => process.exit(1))"], {
        env: { ...process.env, ...vars },
        encoding: 'utf8',
      });

    it("refuses WiPay's live payout API until authorisation is confirmed", () => {
      const live = {
        ENABLE_AUTOMATED_PAYOUTS: 'true',
        WIPAY_PAYOUT_API_URL: 'https://jm.wipayfinancial.com/wapi',
        WIPAY_PAYOUT_API_KEY: 'k',
        WIPAY_PAYOUT_WEBHOOK_SECRET: 's',
      };
      const refused = boot(live);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /WIPAY_PAYOUTS_LIVE_AUTHORIZED/);
      assert.equal(boot({ ...live, WIPAY_PAYOUT_API_URL: 'https://jmsb.wipayfinancial.com/wapi' }).status, 0, 'sandbox is fine');
    });

    it('refuses automated payouts with settings missing', () => {
      const res = boot({ ENABLE_AUTOMATED_PAYOUTS: 'true', WIPAY_PAYOUT_API_URL: 'https://jmsb.wipayfinancial.com/wapi' });
      assert.equal(res.status, 1);
      assert.match(res.stderr, /require WIPAY_PAYOUT_API_URL/);
    });
  });
});
