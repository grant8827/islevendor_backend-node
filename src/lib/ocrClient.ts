import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { env } from '../env.js';

// 'license' | 'insurance' | 'registration' are driver-onboarding documents;
// 'photo_id' covers the reseller/small-vendor onboarding flows' own personal
// photo ID upload (driver's license / passport / voter ID / government ID) —
// same shape of check (name-on-file match + expiry), different upload field.
export type KycDocumentType = 'license' | 'insurance' | 'registration' | 'photo_id';

export interface DocumentCheckResult {
  status: 'verified' | 'name_mismatch' | 'expired' | 'needs_review';
  documentType: KycDocumentType;
  extractedName: string | null;
  nameMatch: boolean | null;
  nameMatchScore: number | null;
  expiryDate: string | null; // ISO date (YYYY-MM-DD)
  isExpired: boolean | null;
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
  };
}

interface VerifyDocumentApiResponse {
  status: DocumentCheckResult['status'];
  extracted_name: string | null;
  name_match: boolean | null;
  name_match_score: number | null;
  expiry_date: string | null;
  is_expired: boolean | null;
}

/**
 * Calls the FastAPI OCR service (backend-fastapi/app/routers/ocr.py) to
 * extract the holder name and expiry date off an onboarding KYC document
 * image/PDF, and check the name against `expectedName` (the applicant's
 * registered legal name). Used by the onboarding routes (driver, reseller,
 * small-vendor) to decide whether to accept an uploaded document — see
 * onboarding.routes.ts's verifyRequiredDocument for what happens with each
 * status.
 */
export async function verifyKycDocument(
  filePath: string,
  mimeType: string,
  documentType: KycDocumentType,
  expectedName: string,
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
    };
  } catch (err) {
    console.error(`[ocrClient] OCR service call failed for ${documentType} document:`, err);
    return serviceUnavailableResult(documentType);
  }
}
