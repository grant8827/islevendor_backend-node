import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, createDriver, createUser, createWarehouse, prisma, startServer, type TestServer, type TestUser } from './helpers.js';
import { migrateLegacyKycDocuments } from '../src/lib/kycDocuments.js';
import { PRIVATE_KYC_DIR, UPLOADS_DIR } from '../src/modules/uploads/uploads.routes.js';

const BASE = '/v1/onboarding';

describe('private KYC documents', () => {
  let server: TestServer;
  let admin: TestUser, customer: TestUser, warehouseOwner: TestUser, applicantDriver: TestUser;
  let driverProfileId: string;
  let warehouseId: string;
  const written: string[] = [];

  /** Writes a file the way multer would have and returns its generated name. */
  async function storeFile(directory: string, extension: string, contents: string) {
    const filename = `${randomUUID()}${extension}`;
    await writeFile(path.join(directory, filename), contents);
    written.push(path.join(directory, filename), path.join(PRIVATE_KYC_DIR, filename));
    return filename;
  }

  before(async () => {
    server = await startServer();
    [admin, customer, warehouseOwner] = await Promise.all([createUser('ADMIN'), createUser('CUSTOMER'), createUser('WAREHOUSE')]);
    applicantDriver = await createDriver({ isKycApproved: false, applicantStatus: 'PENDING_REVIEW' });

    const license = await storeFile(PRIVATE_KYC_DIR, '.png', 'license-image-bytes');
    const insurance = await storeFile(PRIVATE_KYC_DIR, '.pdf', 'insurance-pdf-bytes');
    const profile = await prisma.driverProfile.update({
      where: { userId: applicantDriver.id },
      data: { licenseImageUrl: `private-kyc://${license}`, insuranceCertUrl: `private-kyc://${insurance}` },
    });
    driverProfileId = profile.id;
    warehouseId = await createWarehouse(warehouseOwner.id);
  });

  after(async () => {
    await Promise.all(written.map((file) => rm(file, { force: true })));
    await server.close();
  });

  const requestAccess = (user: TestUser | undefined, type: string, id: string, kind: string) =>
    api(server, `${BASE}/${type}/${id}/documents/${kind}/access`, { method: 'POST', token: user?.token });
  const auditCount = (action: string, targetId: string) => prisma.auditEvent.count({ where: { action, targetId } });

  it('does not serve uploaded files from a public path', async () => {
    const filename = await storeFile(UPLOADS_DIR, '.png', 'legacy');
    assert.equal((await fetch(`${server.baseUrl}/uploads/${filename}`)).status, 404);
    assert.equal((await fetch(`${server.baseUrl}/private-kyc/${filename}`)).status, 404);
  });

  it('lists which documents are on file, to admins only, without exposing references', async () => {
    const res = await api(server, `${BASE}/driver/${driverProfileId}/documents`, { token: admin.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [
      { kind: 'license', onFile: true },
      { kind: 'selfie', onFile: false },
      { kind: 'insurance', onFile: true },
      { kind: 'registration', onFile: false },
    ]);

    assert.equal((await api(server, `${BASE}/driver/${driverProfileId}/documents`)).status, 401);
    for (const user of [customer, warehouseOwner, applicantDriver]) {
      assert.equal((await api(server, `${BASE}/driver/${driverProfileId}/documents`, { token: user.token })).status, 403);
    }
  });

  it('gives an admin a working link, and records who was granted access to what', async () => {
    const before_ = await auditCount('kyc_document.access_granted', driverProfileId);
    const res = await requestAccess(admin, 'driver', driverProfileId, 'license');
    assert.equal(res.status, 201);

    // No Authorization header — the link stands on its own, like an <img src>.
    const file = await fetch(res.body.url);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'license-image-bytes');
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(file.headers.get('cache-control'), 'private, no-store');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

    const events = await prisma.auditEvent.findMany({ where: { action: 'kyc_document.access_granted', targetId: driverProfileId } });
    assert.equal(events.length, before_ + 1);
    const event = events.at(-1)!;
    assert.equal(event.actorId, admin.id);
    assert.equal(event.targetType, 'driver');
    assert.deepEqual(event.metadata, { kind: 'license' });
  });

  it('refuses a link to everyone who is not an admin, the applicant included', async () => {
    const before_ = await auditCount('kyc_document.access_granted', driverProfileId);
    assert.equal((await requestAccess(undefined, 'driver', driverProfileId, 'license')).status, 401);
    for (const user of [customer, warehouseOwner, applicantDriver]) {
      assert.equal((await requestAccess(user, 'driver', driverProfileId, 'license')).status, 403, `${user.role} must be refused`);
    }
    assert.equal(await auditCount('kyc_document.access_granted', driverProfileId), before_);
  });

  it('rejects a tampered or expired link', async () => {
    const { url } = (await requestAccess(admin, 'driver', driverProfileId, 'license')).body as { url: string };
    const [prefix, signature] = [url.slice(0, url.lastIndexOf('.')), url.slice(url.lastIndexOf('.') + 1)];

    assert.equal((await fetch(`${prefix}.${signature.slice(0, -2)}AA`)).status, 403);
    assert.equal((await fetch(`${server.baseUrl}/api${BASE}/documents/view/garbage`)).status, 403);

    // Re-point a validly signed link at a different document.
    const body = JSON.parse(Buffer.from(prefix.slice(prefix.lastIndexOf('/') + 1), 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...body, kind: 'insurance' })).toString('base64url');
    assert.equal((await fetch(`${server.baseUrl}/api${BASE}/documents/view/${forged}.${signature}`)).status, 403);

    mock.timers.enable({ apis: ['Date'], now: Date.now() - 10 * 60 * 1000 });
    const expired = (await requestAccess(admin, 'driver', driverProfileId, 'license')).body.url;
    mock.timers.reset();
    assert.equal((await fetch(expired)).status, 403);
  });

  it('returns 404 for a document that is not on file or not a kind this applicant has', async () => {
    assert.equal((await requestAccess(admin, 'driver', driverProfileId, 'selfie')).status, 404);
    assert.equal((await requestAccess(admin, 'driver', driverProfileId, 'cocj')).status, 404);
    assert.equal((await requestAccess(admin, 'driver', randomUUID(), 'license')).status, 404);
    assert.equal((await requestAccess(admin, 'nonsense', driverProfileId, 'license')).status, 400);
  });

  it('never resolves a stored reference to a path outside the document stores', async () => {
    const hostile = ['private-kyc://../.env', '/uploads/../.env', 'private-kyc://../../package.json', 'file:///etc/passwd', '/etc/passwd'];
    for (const reference of hostile) {
      await prisma.warehouse.update({ where: { id: warehouseId }, data: { cocjDocUrl: reference } });
      assert.equal((await requestAccess(admin, 'warehouse', warehouseId, 'cocj')).status, 404, `"${reference}" must not resolve`);
    }
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { cocjDocUrl: null } });
  });

  it('serves a legacy document through an authorized link, then migrates it into private storage', async () => {
    const filename = await storeFile(UPLOADS_DIR, '.pdf', 'legacy-trn-card');
    const legacyReference = `https://api.example.test/uploads/${filename}`;
    await prisma.warehouse.update({ where: { id: warehouseId }, data: { trnCardUrl: legacyReference } });

    const { url } = (await requestAccess(admin, 'warehouse', warehouseId, 'trn-card')).body;
    assert.equal(await (await fetch(url)).text(), 'legacy-trn-card');

    const mine = (docs: Awaited<ReturnType<typeof migrateLegacyKycDocuments>>) => docs.filter((d) => d.id === warehouseId);

    // Report-only by default: nothing moves.
    assert.deepEqual(mine(await migrateLegacyKycDocuments({ apply: false })), [
      { type: 'warehouse', id: warehouseId, kind: 'trn-card', reference: legacyReference, result: 'would-move' },
    ]);
    assert.ok(existsSync(path.join(UPLOADS_DIR, filename)));

    assert.equal(mine(await migrateLegacyKycDocuments({ apply: true }))[0].result, 'moved');
    assert.ok(!existsSync(path.join(UPLOADS_DIR, filename)));
    assert.ok(existsSync(path.join(PRIVATE_KYC_DIR, filename)));
    const warehouse = await prisma.warehouse.findUniqueOrThrow({ where: { id: warehouseId } });
    assert.equal(warehouse.trnCardUrl, `private-kyc://${filename}`);

    // Still viewable, and a second run finds nothing left to do.
    const again = (await requestAccess(admin, 'warehouse', warehouseId, 'trn-card')).body.url;
    assert.equal(await (await fetch(again)).text(), 'legacy-trn-card');
    assert.deepEqual(mine(await migrateLegacyKycDocuments({ apply: true })), []);
  });

  it('lets only an admin delete a document, audits it, and kills outstanding links', async () => {
    const insurancePath = path.join(
      PRIVATE_KYC_DIR,
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } })).insuranceCertUrl!.slice('private-kyc://'.length),
    );
    const { url } = (await requestAccess(admin, 'driver', driverProfileId, 'insurance')).body;
    const del = (user: TestUser) => api(server, `${BASE}/driver/${driverProfileId}/documents/insurance`, { method: 'DELETE', token: user.token });

    for (const user of [customer, applicantDriver]) assert.equal((await del(user)).status, 403);
    assert.ok(existsSync(insurancePath));

    assert.equal((await del(admin)).status, 204);
    assert.ok(!existsSync(insurancePath));
    assert.equal((await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } })).insuranceCertUrl, null);
    assert.equal(await auditCount('kyc_document.deleted', driverProfileId), 1);

    assert.equal((await fetch(url)).status, 404, 'a link issued before deletion must stop working');
    assert.equal((await del(admin)).status, 404);
  });

  it('audits an applicant decision with the admin who made it', async () => {
    const res = await api(server, `${BASE}/driver/${driverProfileId}/decision`, { method: 'POST', token: admin.token, body: { decision: 'REJECTED' } });
    assert.equal(res.status, 200);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'applicant.decision', targetId: driverProfileId } });
    assert.equal(event.actorId, admin.id);
    assert.deepEqual(event.metadata, { decision: 'REJECTED' });
  });
});
