import crypto from 'node:crypto';
import path from 'node:path';
import { rename, unlink } from 'node:fs/promises';
import { env } from '../env.js';
import { prisma } from './prisma.js';
import { PRIVATE_KYC_DIR, UPLOADS_DIR } from '../modules/uploads/uploads.routes.js';

export type ApplicantType = 'warehouse' | 'reseller' | 'small-vendor' | 'driver';

// Every identity/verification document an applicant can have on file, by
// applicant type: public-facing document kind -> the column holding its
// storage reference. This map is the whole universe of private documents —
// a document is only ever addressed as (applicant type, applicant id, kind),
// never by a client-supplied path or filename.
const DOCUMENT_FIELDS = {
  warehouse: { cocj: 'cocjDocUrl', 'trn-card': 'trnCardUrl', 'proof-of-address': 'proofOfAddressUrl' },
  reseller: { 'photo-id': 'idDocUrl' },
  'small-vendor': { 'photo-id': 'govIdDocUrl' },
  driver: {
    license: 'licenseImageUrl',
    selfie: 'selfieImageUrl',
    insurance: 'insuranceCertUrl',
    registration: 'registrationCertUrl',
  },
} as const satisfies Record<ApplicantType, Record<string, string>>;

export function documentKindsFor(type: ApplicantType): string[] {
  return Object.keys(DOCUMENT_FIELDS[type]);
}

/** Stored references for every document kind of one applicant, or null if the applicant doesn't exist. */
export async function loadDocumentReferences(type: ApplicantType, id: string): Promise<Record<string, string | null> | null> {
  const fields: Record<string, string> = DOCUMENT_FIELDS[type];
  const select = Object.fromEntries(Object.values(fields).map((column) => [column, true]));
  const where = { id };

  let row: Record<string, unknown> | null;
  switch (type) {
    case 'warehouse':
      row = await prisma.warehouse.findUnique({ where, select });
      break;
    case 'reseller':
      row = await prisma.resellerStore.findUnique({ where, select });
      break;
    case 'small-vendor':
      row = await prisma.shop.findUnique({ where, select });
      break;
    case 'driver':
      row = await prisma.driverProfile.findUnique({ where, select });
      break;
  }
  if (!row) return null;
  return Object.fromEntries(Object.entries(fields).map(([kind, column]) => [kind, (row[column] as string | null) ?? null]));
}

/** Overwrites one document's stored reference (null clears it). */
export async function setDocumentReference(type: ApplicantType, id: string, kind: string, reference: string | null) {
  const column = (DOCUMENT_FIELDS[type] as Record<string, string>)[kind];
  const data = { [column]: reference };
  const where = { id };
  switch (type) {
    case 'warehouse':
      return prisma.warehouse.update({ where, data });
    case 'reseller':
      return prisma.resellerStore.update({ where, data });
    case 'small-vendor':
      return prisma.shop.update({ where, data });
    case 'driver':
      return prisma.driverProfile.update({ where, data });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

// What multer's storage in uploads.routes.ts names every file it writes.
const STORED_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/;

export interface StoredDocument {
  absolutePath: string;
  filename: string;
  contentType: string;
  /** True for a document still sitting in the old public uploads directory. */
  legacy: boolean;
}

/**
 * Turns a stored reference into a file on disk. Two shapes exist:
 *  - `private-kyc://<file>` — current; lives in PRIVATE_KYC_DIR.
 *  - `/uploads/<file>` (optionally with a scheme and host in front) — from
 *    before KYC files were separated from public product images; lives in
 *    UPLOADS_DIR until migrateLegacyKycDocuments moves it.
 * Anything else — including a filename that isn't one this server generated
 * — resolves to null rather than to a path.
 */
export function resolveStoredDocument(reference: string | null): StoredDocument | null {
  if (!reference) return null;

  let directory: string;
  let filename: string;
  if (reference.startsWith('private-kyc://')) {
    directory = PRIVATE_KYC_DIR;
    filename = reference.slice('private-kyc://'.length);
  } else {
    const match = /^(?:https?:\/\/[^/]+)?\/uploads\/([^/?#]+)$/.exec(reference);
    if (!match) return null;
    directory = UPLOADS_DIR;
    filename = match[1];
  }

  const contentType = CONTENT_TYPES[path.extname(filename)];
  if (!STORED_FILENAME.test(filename) || !contentType) return null;
  return { absolutePath: path.join(directory, filename), filename, contentType, legacy: directory === UPLOADS_DIR };
}

// ── Short-lived access links ────────────────────────────────────────────────

// A browser can't attach an Authorization header to an <img> or an embedded
// PDF, so an authorized, audited request is exchanged for a link that works
// on its own for a couple of minutes — the same model as an object store's
// presigned URL, which is what this becomes once the files move off disk.
export const DOCUMENT_LINK_TTL_SECONDS = 120;

// Derived, so a document link can't be forged from (or replayed as) a login
// token or a pickup token.
const signingKey = crypto.createHmac('sha256', env.JWT_SECRET).update('islevendor:kyc-document-link:v1').digest();

export interface DocumentLinkClaims {
  type: ApplicantType;
  id: string;
  kind: string;
  actorId: string;
  expiresAt: number;
}

function sign(body: string): string {
  return crypto.createHmac('sha256', signingKey).update(body).digest('base64url');
}

export function issueDocumentLink(claims: Omit<DocumentLinkClaims, 'expiresAt'>): { token: string; expiresAt: Date } {
  const expiresAt = Math.floor(Date.now() / 1000) + DOCUMENT_LINK_TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ ...claims, expiresAt })).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(expiresAt * 1000) };
}

export function verifyDocumentLink(token: string): DocumentLinkClaims | null {
  const [body, signature, ...rest] = token.split('.');
  if (!body || !signature || rest.length > 0) return null;

  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as DocumentLinkClaims;
    return claims.expiresAt * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

// ── Deletion and legacy migration ───────────────────────────────────────────

/** Removes a document's file and clears its reference. Returns false if there was nothing on file. */
export async function deleteDocument(type: ApplicantType, id: string, kind: string, reference: string | null): Promise<boolean> {
  if (!reference) return false;
  const stored = resolveStoredDocument(reference);
  if (stored) {
    // Already gone from disk is fine — the reference still needs clearing.
    await unlink(stored.absolutePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  await setDocumentReference(type, id, kind, null);
  return true;
}

export interface LegacyDocument {
  type: ApplicantType;
  id: string;
  kind: string;
  reference: string;
  /** 'moved' / 'would-move', or why it couldn't be: the file is missing, or the reference isn't one this server wrote. */
  result: 'moved' | 'would-move' | 'file-missing' | 'unrecognised-reference';
}

/**
 * Finds every KYC document still referenced at its old public `/uploads/…`
 * location — each of those URLs was world-readable while the uploads
 * directory was served statically — and, with `apply`, moves the file into
 * PRIVATE_KYC_DIR and rewrites the reference. Without `apply` it only
 * reports. Safe to re-run: a moved document no longer matches.
 */
export async function migrateLegacyKycDocuments({ apply }: { apply: boolean }): Promise<LegacyDocument[]> {
  const found: LegacyDocument[] = [];
  const applicants = {
    warehouse: await prisma.warehouse.findMany({ select: { id: true } }),
    reseller: await prisma.resellerStore.findMany({ select: { id: true } }),
    'small-vendor': await prisma.shop.findMany({ select: { id: true } }),
    driver: await prisma.driverProfile.findMany({ select: { id: true } }),
  } satisfies Record<ApplicantType, { id: string }[]>;

  for (const type of Object.keys(applicants) as ApplicantType[]) {
    for (const { id } of applicants[type]) {
      const references = (await loadDocumentReferences(type, id)) ?? {};
      for (const [kind, reference] of Object.entries(references)) {
        if (!reference || reference.startsWith('private-kyc://')) continue;

        const stored = resolveStoredDocument(reference);
        if (!stored) {
          found.push({ type, id, kind, reference, result: 'unrecognised-reference' });
          continue;
        }
        if (!apply) {
          found.push({ type, id, kind, reference, result: 'would-move' });
          continue;
        }
        try {
          await rename(stored.absolutePath, path.join(PRIVATE_KYC_DIR, stored.filename));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          found.push({ type, id, kind, reference, result: 'file-missing' });
          continue;
        }
        await setDocumentReference(type, id, kind, `private-kyc://${stored.filename}`);
        found.push({ type, id, kind, reference, result: 'moved' });
      }
    }
  }
  return found;
}
