import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { kycUpload } from '../uploads/uploads.routes.js';
import { trnSchema } from '../../lib/trn.js';
import { PARISHES, type Parish } from '../../lib/parishes.js';
import { verifyKycDocument, type KycDocumentType, type DocumentCheckResult } from '../../lib/ocrClient.js';
import {
  registerWarehouseApplicant,
  registerResellerApplicant,
  registerVendorApplicant,
  registerDriverApplicant,
} from './onboarding.service.js';

export const onboardingRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// Shared multipart/zod plumbing
// ─────────────────────────────────────────────────────────────────────────

// Every onboarding form is submitted as multipart/form-data (text fields +
// KYC document files) in one request — see ISLE-105. Multer/busboy gives
// repeated-name fields (e.g. coverageParishes appended more than once) back
// as an array, and a single occurrence back as a bare string; this
// normalizes either shape to string[] for zod.
function toArray(value: unknown): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

// multer's fileFilter check happens per-file — HttpError thrown from a
// fileFilter propagates through Express's error-handling middleware chain,
// so no extra try/catch is needed around kycUpload.fields(...) itself.
type UploadedFiles = Record<string, Express.Multer.File[] | undefined>;

function fileUrl(files: UploadedFiles, field: string): string | undefined {
  const file = files[field]?.[0];
  return file ? `/uploads/${file.filename}` : undefined;
}

function requireFileUrl(files: UploadedFiles, field: string, label: string): string {
  const url = fileUrl(files, field);
  if (!url) throw new HttpError(400, `${label} is required`);
  return url;
}

// Runs the FastAPI OCR check (src/lib/ocrClient.ts) on one required
// onboarding KYC document — driver's license/insurance/registration, or a
// reseller/small-vendor's own photo ID. Only an *expired* document is
// rejected outright, before any account/profile is created — that's an
// objective date comparison once a date is found. A name mismatch is NOT
// rejected here: name-on-document extraction is far more error-prone (fonts,
// middle names, maiden names, business-owned vehicles), so a false mismatch
// would wrongly lock out a legitimate applicant with no recourse. Instead
// it's stored as a flag (see toDocumentVerificationStatus) for the admin
// reviewing the application in the /pending queue to check against the
// actual document themselves. A document the OCR service couldn't
// confidently read at all (`needs_review`) is likewise not rejected — see
// ocrClient.ts's serviceUnavailableResult doc comment.
async function verifyRequiredDocument(
  files: UploadedFiles,
  field: string,
  documentType: KycDocumentType,
  label: string,
  expectedName: string,
): Promise<DocumentCheckResult> {
  const file = files[field]?.[0];
  if (!file) throw new HttpError(400, `${label} is required`);

  const result = await verifyKycDocument(file.path, file.mimetype, documentType, expectedName);

  if (result.status === 'expired') {
    throw new HttpError(400, `${label} has expired — upload a current one.`);
  }
  return result;
}

function toDocumentVerificationStatus(status: DocumentCheckResult['status']): 'VERIFIED' | 'NAME_MISMATCH' | 'NEEDS_REVIEW' {
  // Only reachable with 'verified', 'name_mismatch', or 'needs_review' —
  // verifyRequiredDocument above throws before returning 'expired'.
  if (status === 'verified') return 'VERIFIED';
  if (status === 'name_mismatch') return 'NAME_MISMATCH';
  return 'NEEDS_REVIEW';
}

const accountSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1),
  phoneNumber: z.string().min(7),
});

const parishSchema = z.enum(PARISHES as unknown as [Parish, ...Parish[]]);

// z.coerce.boolean() treats the string "false" as truthy (Boolean("false")
// is true) — multipart fields are always strings, so checkboxes need this
// instead.
const boolFromFormField = z.preprocess((v) => v === 'true' || v === true, z.boolean());

const slaAcceptedSchema = z.preprocess(
  (v) => v === 'true' || v === true,
  z.boolean().refine((v) => v === true, { message: 'You must accept the SLA/terms to continue' }),
);

const markupSchema = z.coerce.number().min(1, 'Markup must be at least 1%').max(100, 'Markup cannot exceed 100%');

const payoutSchema = z
  .object({
    payoutMethod: z.enum(['BANK', 'LYNK_WALLET']),
    bankName: z.string().optional(),
    accountHolderName: z.string().optional(),
    accountNumber: z.string().optional(),
    branchCode: z.string().optional(),
    lynkWalletId: z.string().optional(),
  })
  .refine(
    (v) => (v.payoutMethod === 'BANK' ? Boolean(v.bankName && v.accountHolderName && v.accountNumber && v.branchCode) : true),
    { message: 'Bank name, account holder name, account number, and branch code are all required for bank payout' },
  )
  .refine((v) => (v.payoutMethod === 'LYNK_WALLET' ? Boolean(v.lynkWalletId) : true), {
    message: 'Lynk wallet ID is required for Lynk payout',
  });

// ─────────────────────────────────────────────────────────────────────────
// ISLE-101 — POST /api/v1/onboarding/warehouse
// ─────────────────────────────────────────────────────────────────────────

const warehouseSchema = accountSchema
  .extend({
    hubName: z.string().min(1),
    legalBusinessName: z.string().min(1),
    trn: trnSchema,
    gctNumber: z.string().optional(),
    contactName: z.string().min(1),
    contactPhone: z.string().min(7),
    contactEmail: z.string().email().optional().or(z.literal('')),
    addressLine: z.string().min(1),
    town: z.string().min(1),
    parish: parishSchema,
    storageSqFt: z.coerce.number().int().positive(),
    loadingBayCount: z.coerce.number().int().min(0),
    operatingHours: z.string().min(1),
  })
  .and(payoutSchema);

onboardingRouter.post(
  '/warehouse',
  kycUpload.fields([{ name: 'cocjDoc', maxCount: 1 }, { name: 'trnCard', maxCount: 1 }, { name: 'proofOfAddress', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const input = warehouseSchema.parse(req.body);
      const files = (req.files ?? {}) as UploadedFiles;
      const coverageParishes = toArray(req.body.coverageParishes).filter((p) => (PARISHES as readonly string[]).includes(p));
      if (coverageParishes.length < 1) throw new HttpError(400, 'Select at least one coverage parish');
      const storageTypes = toArray(req.body.storageTypes);
      const securityControls = toArray(req.body.securityControls);

      const result = await registerWarehouseApplicant({
        ...input,
        contactEmail: input.contactEmail || undefined,
        coverageParishes,
        storageTypes,
        securityControls,
        cocjDocUrl: requireFileUrl(files, 'cocjDoc', 'COCJ business registration document'),
        trnCardUrl: requireFileUrl(files, 'trnCard', 'TRN card photo'),
        proofOfAddressUrl: requireFileUrl(files, 'proofOfAddress', 'Proof of address'),
      });

      res.status(201).json({ ...result, status: 'PENDING_REVIEW' });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// ISLE-102 — POST /api/v1/onboarding/reseller
// ─────────────────────────────────────────────────────────────────────────

const resellerSchema = accountSchema
  .extend({
    resellerType: z.enum(['INDIVIDUAL_CREATOR', 'REGISTERED_BUSINESS']),
    storeName: z.string().min(1),
    legalName: z.string().min(1),
    trn: trnSchema,
    contactPhone: z.string().min(7),
    parish: parishSchema,
    instagramHandle: z.string().optional(),
    tiktokHandle: z.string().optional(),
    primarySalesChannel: z.enum(['SOCIAL', 'WHATSAPP', 'WEBSITE', 'POP_UP']),
    defaultMarkupPercent: markupSchema,
    slaAccepted: slaAcceptedSchema,
  })
  .and(payoutSchema);

onboardingRouter.post('/reseller', kycUpload.fields([{ name: 'idDoc', maxCount: 1 }]), async (req, res, next) => {
  try {
    const input = resellerSchema.parse(req.body);
    const files = (req.files ?? {}) as UploadedFiles;
    const targetCategories = toArray(req.body.targetCategories);
    if (targetCategories.length < 1) throw new HttpError(400, 'Select at least one target product category');

    const idDocLabel = 'Photo ID (driver’s license / passport / voter ID)';
    const idDocCheck = await verifyRequiredDocument(files, 'idDoc', 'photo_id', idDocLabel, input.fullName);

    const result = await registerResellerApplicant({
      ...input,
      targetCategories,
      idDocUrl: requireFileUrl(files, 'idDoc', idDocLabel),
      idDocHolderName: idDocCheck.extractedName ?? undefined,
      idDocExpiry: idDocCheck.expiryDate ? new Date(idDocCheck.expiryDate) : undefined,
      idDocVerificationStatus: toDocumentVerificationStatus(idDocCheck.status),
    });

    res.status(201).json({ ...result, status: 'PENDING_REVIEW' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ISLE-103 — POST /api/v1/onboarding/small-vendor
// ─────────────────────────────────────────────────────────────────────────

const vendorSchema = accountSchema
  .extend({
    brandName: z.string().min(1),
    vendorCategory: z.enum(['ARTISAN', 'COTTAGE_FOOD', 'RETAIL_BOUTIQUE', 'AGRI_PROCESSOR']),
    ownerName: z.string().min(1),
    trn: trnSchema,
    whatsappNumber: z.string().min(7),
    parish: parishSchema,
    addressLine: z.string().min(1),
    primaryProductCategory: z.string().min(1),
    estimatedItemCount: z.coerce.number().int().positive(),
    fulfillmentStrategy: z.enum(['SELF_DISPATCH', 'HUB_CONSIGNMENT', 'HYBRID']),
    pickupAddress: z.string().optional(),
    slaAccepted: slaAcceptedSchema,
  })
  .and(payoutSchema);

onboardingRouter.post('/small-vendor', kycUpload.fields([{ name: 'govId', maxCount: 1 }]), async (req, res, next) => {
  try {
    const input = vendorSchema.parse(req.body);
    const files = (req.files ?? {}) as UploadedFiles;

    const govIdLabel = 'Government ID photo';
    const govIdCheck = await verifyRequiredDocument(files, 'govId', 'photo_id', govIdLabel, input.fullName);

    const result = await registerVendorApplicant({
      ...input,
      govIdDocUrl: requireFileUrl(files, 'govId', govIdLabel),
      govIdHolderName: govIdCheck.extractedName ?? undefined,
      govIdExpiry: govIdCheck.expiryDate ? new Date(govIdCheck.expiryDate) : undefined,
      govIdVerificationStatus: toDocumentVerificationStatus(govIdCheck.status),
    });

    res.status(201).json({ ...result, status: 'PENDING_REVIEW', reviewEta: '12-24 hrs' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ISLE-104 — POST /api/v1/onboarding/driver
// ─────────────────────────────────────────────────────────────────────────

const driverSchema = accountSchema
  .extend({
    trn: trnSchema,
    whatsappNumber: z.string().min(7),
    homeParish: parishSchema,
    homeTown: z.string().min(1),
    vehicleType: z.enum(['MOTORCYCLE', 'SEDAN', 'CARGO_VAN', 'BOX_TRUCK']),
    vehicleMake: z.string().min(1),
    vehicleModel: z.string().min(1),
    vehicleYear: z.coerce.number().int().min(1980).max(new Date().getFullYear() + 1),
    licensePlate: z.string().min(1),
    hasColdBox: boolFromFormField,
    availability: z.enum(['FULL_TIME', 'PART_TIME', 'WEEKEND']),
  })
  .and(payoutSchema);

onboardingRouter.post(
  '/driver',
  kycUpload.fields([{ name: 'licensePhoto', maxCount: 1 }, { name: 'insuranceCert', maxCount: 1 }, { name: 'registrationCert', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const input = driverSchema.parse(req.body);
      const files = (req.files ?? {}) as UploadedFiles;
      const zoneParishes = toArray(req.body.zoneParishes).filter((p) => (PARISHES as readonly string[]).includes(p));
      if (zoneParishes.length < 1) throw new HttpError(400, 'Select at least one operating zone parish');

      // Name-match + expiry check against the applicant's own registered
      // name (input.fullName) — run before creating any account/profile so
      // a rejected document never gets partially onboarded.
      const [licenseCheck, insuranceCheck, registrationCheck] = await Promise.all([
        verifyRequiredDocument(files, 'licensePhoto', 'license', "Driver's license photo", input.fullName),
        verifyRequiredDocument(files, 'insuranceCert', 'insurance', 'Certificate of insurance', input.fullName),
        verifyRequiredDocument(files, 'registrationCert', 'registration', 'Certificate of registration', input.fullName),
      ]);

      const result = await registerDriverApplicant({
        ...input,
        zoneParishes,
        licensePhotoUrl: requireFileUrl(files, 'licensePhoto', "Driver's license photo"),
        licenseHolderName: licenseCheck.extractedName ?? undefined,
        licenseExpiry: licenseCheck.expiryDate ? new Date(licenseCheck.expiryDate) : undefined,
        licenseVerificationStatus: toDocumentVerificationStatus(licenseCheck.status),
        insuranceCertUrl: requireFileUrl(files, 'insuranceCert', 'Certificate of insurance'),
        insuranceHolderName: insuranceCheck.extractedName ?? undefined,
        insuranceCertExpiry: insuranceCheck.expiryDate ? new Date(insuranceCheck.expiryDate) : undefined,
        insuranceVerificationStatus: toDocumentVerificationStatus(insuranceCheck.status),
        registrationCertUrl: requireFileUrl(files, 'registrationCert', 'Certificate of registration'),
        registrationHolderName: registrationCheck.extractedName ?? undefined,
        registrationCertExpiry: registrationCheck.expiryDate ? new Date(registrationCheck.expiryDate) : undefined,
        registrationVerificationStatus: toDocumentVerificationStatus(registrationCheck.status),
      });

      res.status(201).json({ ...result, status: 'PENDING_REVIEW' });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Admin review queue — the "admin verification alert" from ISLE-101's AC,
// implemented as a pull (list pending applicants) rather than a push
// (email/Slack) since there's no notification provider wired into this
// codebase yet. TODO: wire an actual push (email/Slack webhook) once a
// provider + credentials are available — this is a reasonable interim step,
// not the final form of "alert".
// ─────────────────────────────────────────────────────────────────────────

onboardingRouter.get('/pending', requireAuth, requireRole(UserRole.ADMIN), async (_req, res, next) => {
  try {
    const [warehouses, resellers, vendors, drivers] = await Promise.all([
      prisma.warehouse.findMany({
        where: { applicantStatus: 'PENDING_REVIEW' },
        select: { id: true, name: true, referenceId: true, town: true, parish: true, user: { select: { email: true, fullName: true } } },
      }),
      prisma.resellerStore.findMany({
        where: { applicantStatus: 'PENDING_REVIEW' },
        select: {
          id: true,
          storeName: true,
          referenceId: true,
          parish: true,
          user: { select: { email: true, fullName: true } },
          // See driverProfile's select below for why these are surfaced.
          idDocHolderName: true,
          idDocVerificationStatus: true,
        },
      }),
      prisma.shop.findMany({
        where: { applicantStatus: 'PENDING_REVIEW' },
        select: {
          id: true,
          shopName: true,
          referenceId: true,
          parish: true,
          user: { select: { email: true, fullName: true } },
          govIdHolderName: true,
          govIdVerificationStatus: true,
        },
      }),
      prisma.driverProfile.findMany({
        where: { applicantStatus: 'PENDING_REVIEW' },
        select: {
          id: true,
          referenceId: true,
          homeParish: true,
          user: { select: { email: true, fullName: true } },
          // Surfaced so whoever reviews this queue can see a name-mismatch
          // flag (see onboarding.routes.ts's verifyRequiredDocument) and
          // check it against the actual uploaded document before deciding —
          // it's a flag for a human to look at, not an auto-reject.
          licenseHolderName: true,
          licenseVerificationStatus: true,
          insuranceHolderName: true,
          insuranceVerificationStatus: true,
          registrationHolderName: true,
          registrationVerificationStatus: true,
        },
      }),
    ]);

    res.json({
      warehouses: warehouses.map((w) => ({ type: 'warehouse', ...w })),
      resellers: resellers.map((r) => ({ type: 'reseller', ...r })),
      vendors: vendors.map((v) => ({ type: 'small-vendor', ...v })),
      drivers: drivers.map((d) => ({ type: 'driver', ...d })),
    });
  } catch (err) {
    next(err);
  }
});

const applicantTypeSchema = z.enum(['warehouse', 'reseller', 'small-vendor', 'driver']);
const decisionSchema = z.enum(['APPROVED', 'REJECTED']);

// One decision endpoint for all four applicant types — DRY rather than four
// near-identical approve/reject route pairs.
onboardingRouter.post('/:type/:id/decision', requireAuth, requireRole(UserRole.ADMIN), async (req, res, next) => {
  try {
    const type = applicantTypeSchema.parse(req.params.type);
    const id = z.string().uuid().parse(req.params.id);
    const applicantStatus = decisionSchema.parse(req.body.decision);

    const updated = await (() => {
      switch (type) {
        case 'warehouse':
          return prisma.warehouse.update({ where: { id }, data: { applicantStatus } });
        case 'reseller':
          return prisma.resellerStore.update({ where: { id }, data: { applicantStatus } });
        case 'small-vendor':
          return prisma.shop.update({ where: { id }, data: { applicantStatus } });
        case 'driver':
          return prisma.driverProfile.update({ where: { id }, data: { applicantStatus } });
      }
    })();

    res.json({ id: updated.id, applicantStatus: updated.applicantStatus });
  } catch (err) {
    next(err);
  }
});
