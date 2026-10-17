import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { env } from '../env.js';

// 'license' | 'insurance' | 'registration' are a driver's documents;
// 'photo_id' is a reseller's or small vendor's own photo ID; 'trn_card' |
// 'business_registration' | 'proof_of_address' are a warehouse's.
export type KycDocumentType = 'license' | 'insurance' | 'registration' | 'photo_id' | 'trn_card' | 'business_registration' | 'proof_of_address';

export interface DocumentCheckResult {
  // expired and stale (a proof of address over 90 days old) are objective
  // date checks the onboarding routes block on; name_mismatch and
  // details_mismatch are findings for an admin; needs_review means the
  // document couldn't be read confidently.
  status: 'verified' | 'name_mismatch' | 'details_mismatch' | 'expired' | 'stale' | 'needs_review';
  documentType: KycDocumentType;
  extractedName: string | null;
  nameMatch: boolean | null;
  nameMatchScore: number | null;
  expiryDate: string | null; // ISO date (YYYY-MM-DD)
  isExpired: boolean | null;
  documentDate: string | null; // proof of address: when it was issued
  problems: string[];
}

/** What else to check the document against, beyond the applicant's name. */
export interface DocumentExpectations {
  // Another name it may be in — a business document in the owner's name.
  alternateName?: string;
  trn?: string;
  plate?: string;
  address?: string;
}

// Used when the FastAPI OCR service can't be reached, times out, or returns
// something unexpected. Falls back to "needs_review" (non-blocking) rather
// than failing the whole onboarding submission — an applicant shouldn't be
// hard-rejected, and shouldn't be hard-*approved* on a fabricated pass
// either, just because the AI service happened to be down.
function serviceUnavailableResult(documentType: KycDocumentType): DocumentCheckResult {
  return {
    status: 'needs_review',
    documentType,
    extractedName: null,
    nameMatch: null,
    nameMatchScore: null,
    expiryDate: null,
    isExpired: null,
    documentDate: null,
    problems: ['The document check service was unavailable'],
  };
}

interface VerifyDocumentApiResponse {
  status: DocumentCheckResult['status'];
  extracted_name: string | null;
  name_match: boolean | null;
  name_match_score: number | null;
  expiry_date: string | null;
  is_expired: boolean | null;
  document_date?: string | null;
  problems?: string[];
}

/**
 * Calls the FastAPI OCR service (backend-fastapi/app/routers/ocr.py) to read
 * an onboarding document image/PDF and check it against what the applicant
 * entered: their name, and per document the TRN, licence plate or address.
 * See onboarding.routes.ts's verifyRequiredDocument for what happens with
 * each status.
 */
export async function verifyKycDocument(
  filePath: string,
  mimeType: string,
  documentType: KycDocumentType,
  expectedName: string,
  expect: DocumentExpectations = {},
): Promise<DocumentCheckResult> {
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(filePath);
  } catch (err) {
    console.error(`[ocrClient] Failed to read uploaded ${documentType} document at ${filePath}:`, err);
    return serviceUnavailableResult(documentType);
  }

  const form = new FormData();
  form.append('document_type', documentType);
  form.append('expected_name', expectedName);
  if (expect.alternateName) form.append('alternate_name', expect.alternateName);
  if (expect.trn) form.append('expected_trn', expect.trn);
  if (expect.plate) form.append('expected_plate', expect.plate);
  if (expect.address) form.append('expected_address', expect.address);
  form.append('image', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), path.basename(filePath));

  try {
    const res = await fetch(`${env.AI_SERVICE_URL}/ocr/verify-document`, { method: 'POST', body: form });
    if (!res.ok) {
      console.error(`[ocrClient] OCR service returned ${res.status} for ${documentType} document`);
      return serviceUnavailableResult(documentType);
    }
    const data = (await res.json()) as VerifyDocumentApiResponse;
    return {
      status: data.status,
      documentType,
      extractedName: data.extracted_name,
      nameMatch: data.name_match,
      nameMatchScore: data.name_match_score,
      expiryDate: data.expiry_date,
      isExpired: data.is_expired,
      documentDate: data.document_date ?? null,
      problems: data.problems ?? [],
    };
  } catch (err) {
    console.error(`[ocrClient] OCR service call failed for ${documentType} document:`, err);
    return serviceUnavailableResult(documentType);
  }
}

export type ProofType = 'PACKAGE_WITH_ID' | 'PACKAGE_WITH_RECIPIENT';

export interface DeliveryPhotoCheck {
  check: 'PASSED' | 'FLAGGED' | 'NOT_CHECKED';
  note: string | null;
}

/**
 * Asks the AI service whether a proof-of-delivery photo shows what the
 * driver says it does (the recipient, or their ID). Never throws and never
 * blocks: an unreachable service is NOT_CHECKED, and the delivery goes
 * through either way — a flagged photo is for a person to look at.
 */
export async function checkDeliveryPhoto(filePath: string, mimeType: string, proofType: ProofType): Promise<DeliveryPhotoCheck> {
  try {
    const fileBuffer = await readFile(filePath);
    const form = new FormData();
    form.append('proof_type', proofType);
    form.append('image', new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), path.basename(filePath));
    const res = await fetch(`${env.AI_SERVICE_URL}/ocr/delivery-photo`, { method: 'POST', body: form, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.error(`[ocrClient] delivery photo check returned ${res.status}`);
      return { check: 'NOT_CHECKED', note: 'The photo check service was unavailable' };
    }
    const data = (await res.json()) as { status: 'passed' | 'flagged'; reason: string | null };
    return data.status === 'passed' ? { check: 'PASSED', note: null } : { check: 'FLAGGED', note: data.reason ?? 'The photo needs a look' };
  } catch (err) {
    console.error('[ocrClient] delivery photo check failed:', err);
    return { check: 'NOT_CHECKED', note: 'The photo check service was unavailable' };
  }
}
