import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { prisma, startServer, type TestServer } from './helpers.js';

// A warehouse's sign-up documents (COCJ registration, TRN card, proof of
// address) are read by the AI service before anything is created: an
// objective failure (a proof of address over 3 months old) stops the sign-up;
// anything else is recorded for the admin reviewing the application.
describe('warehouse sign-up document checks', () => {
  let server: TestServer;
  let fakeAi: http.Server;
  // The AI service's answer for each document type, and what it was sent.
  let answers: Record<string, { status: string; problems?: string[]; document_date?: string | null }>;
  let received: Record<string, string> = {};

  before(async () => {
    fakeAi = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString('latin1')));
      req.on('end', () => {
        const field = (name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
        const type = field('document_type') ?? '';
        received[type] = body;
        const answer = answers[type] ?? { status: 'verified' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ extracted_name: null, name_match: null, name_match_score: null, expiry_date: null, is_expired: null, problems: [], ...answer }));
      });
    });
    await new Promise<void>((resolve) => fakeAi.listen(18001, '127.0.0.1', resolve));
    server = await startServer();
  });

  after(async () => {
    await server.close();
    fakeAi.close();
  });

  beforeEach(() => {
    answers = {};
    received = {};
  });

  let lastEmail = '';

  function signUp() {
    const form = new FormData();
    lastEmail = `wh-${randomUUID()}@islevendor.test`;
    const fields: Record<string, string> = {
      email: lastEmail,
      password: 'Passw0rd!',
      fullName: 'Marcia Brown',
      phoneNumber: '8765550123',
      hubName: 'Liguanea Hub',
      legalBusinessName: 'Island Gadgets Limited',
      trn: '123-456-789',
      contactName: 'Marcia Brown',
      contactPhone: '8765550123',
      addressLine: '12 Hope Road',
      town: 'Liguanea',
      parish: 'St. Andrew',
      storageSqFt: '2000',
      loadingBayCount: '1',
      operatingHours: 'Mon-Fri 8-5',
      coverageParishes: 'St. Andrew',
      payoutMethod: 'LYNK_WALLET',
      lynkWalletId: '@islandgadgets',
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const name of ['cocjDoc', 'trnCard', 'proofOfAddress']) {
      form.append(name, new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), `${name}.pdf`);
    }
    return fetch(`${server.baseUrl}/api/v1/onboarding/warehouse`, { method: 'POST', body: form });
  }

  /** The warehouse the last sign-up created. */
  const lastWarehouse = () => prisma.warehouse.findFirstOrThrow({ where: { user: { email: lastEmail } } });

  it('checks each document against what was entered, and records the results', async () => {
    const res = await signUp();
    assert.equal(res.status, 201, await res.clone().text());
    assert.match(received.trn_card, /name="expected_trn"\r\n\r\n123-456-789/);
    assert.match(received.proof_of_address, /name="expected_address"\r\n\r\n12 Hope Road Liguanea/);
    assert.match(received.business_registration, /name="expected_name"\r\n\r\nIsland Gadgets Limited/);

    const warehouse = await lastWarehouse();
    assert.equal(warehouse.cocjVerificationStatus, 'VERIFIED');
    assert.equal(warehouse.trnCardVerificationStatus, 'VERIFIED');
    assert.equal(warehouse.proofOfAddressVerificationStatus, 'VERIFIED');
  });

  it('flags a TRN that does not match without blocking the sign-up', async () => {
    answers.trn_card = { status: 'details_mismatch', problems: ["TRN 123-456-789 doesn't match the TRN on the card (987654321)"] };
    const res = await signUp();
    assert.equal(res.status, 201);
    const warehouse = await lastWarehouse();
    assert.equal(warehouse.trnCardVerificationStatus, 'DETAILS_MISMATCH');
    assert.deepEqual(warehouse.documentProblems, ["TRN card: TRN 123-456-789 doesn't match the TRN on the card (987654321)"]);
  });

  it('turns away a proof of address more than three months old, creating nothing', async () => {
    answers.proof_of_address = { status: 'stale', document_date: '2026-01-02' };
    const before = await prisma.warehouse.count();
    const res = await signUp();
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /more than 3 months old/);
    assert.equal(await prisma.warehouse.count(), before);
  });

  it('turns away an expired document', async () => {
    answers.business_registration = { status: 'expired' };
    const res = await signUp();
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /expired/);
  });
});
