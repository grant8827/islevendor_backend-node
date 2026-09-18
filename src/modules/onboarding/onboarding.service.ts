import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type {
  Prisma,
  DriverAvailability,
  DriverVehicleType,
  DocumentVerificationStatus,
  FulfillmentStrategy,
  PayoutMethod,
  ResellerType,
  SalesChannel,
  VendorCategory,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { signAuthToken } from '../../middleware/auth.js';
import { normalizeTrn } from '../../lib/trn.js';
import { PARISH_COORDS, type Parish } from '../../lib/parishes.js';
import { generateUniqueSlug } from '../../lib/slug.js';
import { createWithGeneratedReferenceId } from '../../lib/referenceId.js';

const SALT_ROUNDS = 12;

export interface ApplicantAccountInput {
  email: string;
  password: string;
  fullName: string;
  phoneNumber: string;
}

/**
 * Shared first half of every onboarding flow: create the login-capable User
 * (rejecting a duplicate email same as /auth/register) plus its ledger
 * account, inside the caller's transaction. Every onboarding endpoint calls
 * this, then attaches its role-specific profile row in the same transaction
 * so a half-created applicant (account but no profile, or vice versa) can
 * never happen.
 */
async function createApplicantUser(
  tx: Prisma.TransactionClient,
  input: ApplicantAccountInput,
  role: 'WAREHOUSE' | 'RESELLER' | 'STORE' | 'DRIVER',
) {
  const existing = await tx.user.findUnique({ where: { email: input.email } });
  if (existing) throw new HttpError(409, 'An account with this email already exists');

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
  const user = await tx.user.create({
    data: {
      email: input.email,
      passwordHash,
      fullName: input.fullName,
      phoneNumber: input.phoneNumber,
      role,
    },
  });
  await tx.ledgerAccount.create({ data: { userId: user.id, accountType: role } });
  return user;
}

function centroidFor(parish: Parish) {
  return PARISH_COORDS[parish];
}

// ─────────────────────────────────────────────────────────────────────────
// ISLE-101 — Warehouse hub applicant
// ─────────────────────────────────────────────────────────────────────────

export interface WarehouseApplicantInput extends ApplicantAccountInput {
  hubName: string;
  legalBusinessName: string;
  trn: string;
  gctNumber?: string;
  contactName: string;
  contactPhone: string;
  contactEmail?: string;
  addressLine: string;
  town: string;
  parish: Parish;
  coverageParishes: string[];
  storageSqFt: number;
  loadingBayCount: number;
  operatingHours: string;
  storageTypes: string[];
  securityControls: string[];
  payoutMethod: PayoutMethod;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  branchCode?: string;
  lynkWalletId?: string;
  cocjDocUrl: string;
  trnCardUrl: string;
  proofOfAddressUrl: string;
}

export async function registerWarehouseApplicant(input: WarehouseApplicantInput) {
  const { lat, lng } = centroidFor(input.parish);

  return prisma.$transaction(async (tx) => {
    const user = await createApplicantUser(tx, input, 'WAREHOUSE');

    const id = randomUUID();
    // Raw INSERT for the base row + spatial point (Prisma can't write a
    // `geometry` column directly — see Warehouse model doc comment).
    await tx.$executeRaw`
      INSERT INTO warehouses (id, user_id, name, address_line, parish, location)
      VALUES (${id}::uuid, ${user.id}::uuid, ${input.hubName}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    `;

    const warehouse = await createWithGeneratedReferenceId('WH', (referenceId) =>
      tx.warehouse.update({
        where: { id },
        data: {
          legalBusinessName: input.legalBusinessName,
          trn: normalizeTrn(input.trn),
          gctNumber: input.gctNumber,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          contactEmail: input.contactEmail,
          town: input.town,
          coverageParishes: input.coverageParishes,
          storageSqFt: input.storageSqFt,
          loadingBayCount: input.loadingBayCount,
          operatingHours: input.operatingHours,
          storageTypes: input.storageTypes,
          securityControls: input.securityControls,
          payoutMethod: input.payoutMethod,
          bankName: input.bankName,
          accountHolderName: input.accountHolderName,
          accountNumber: input.accountNumber,
          branchCode: input.branchCode,
          lynkWalletId: input.lynkWalletId,
          cocjDocUrl: input.cocjDocUrl,
          trnCardUrl: input.trnCardUrl,
          proofOfAddressUrl: input.proofOfAddressUrl,
          slaAcceptedAt: new Date(),
          applicantStatus: 'PENDING_REVIEW',
          referenceId,
        },
      }),
    );

    return { referenceId: warehouse.referenceId!, token: signAuthToken({ sub: user.id, role: user.role }) };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ISLE-102 — Reseller partner applicant
// ─────────────────────────────────────────────────────────────────────────

export interface ResellerApplicantInput extends ApplicantAccountInput {
  resellerType: ResellerType;
  storeName: string;
  legalName: string;
  trn: string;
  contactPhone: string;
  parish: string;
  instagramHandle?: string;
  tiktokHandle?: string;
  primarySalesChannel: SalesChannel;
  targetCategories: string[];
  defaultMarkupPercent: number;
  payoutMethod: PayoutMethod;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  branchCode?: string;
  lynkWalletId?: string;
  idDocUrl: string;
  // See DriverApplicantInput's matching comment — populated from the FastAPI
  // OCR check run by the route handler before this is called.
  idDocHolderName?: string;
  idDocExpiry?: Date;
  idDocVerificationStatus?: DocumentVerificationStatus;
}

export async function registerResellerApplicant(input: ResellerApplicantInput) {
  const slug = await generateUniqueSlug(input.storeName);

  return prisma.$transaction(async (tx) => {
    const user = await createApplicantUser(tx, input, 'RESELLER');

    const store = await createWithGeneratedReferenceId('RS', (referenceId) =>
      tx.resellerStore.create({
        data: {
          userId: user.id,
          storeName: input.storeName,
          slug,
          resellerType: input.resellerType,
          legalName: input.legalName,
          trn: normalizeTrn(input.trn),
          contactPhone: input.contactPhone,
          parish: input.parish,
          instagramHandle: input.instagramHandle,
          tiktokHandle: input.tiktokHandle,
          primarySalesChannel: input.primarySalesChannel,
          targetCategories: input.targetCategories,
          defaultMarkupPercent: input.defaultMarkupPercent,
          payoutMethod: input.payoutMethod,
          bankName: input.bankName,
          accountHolderName: input.accountHolderName,
          accountNumber: input.accountNumber,
          branchCode: input.branchCode,
          lynkWalletId: input.lynkWalletId,
          idDocUrl: input.idDocUrl,
          idDocHolderName: input.idDocHolderName,
          idDocExpiry: input.idDocExpiry,
          idDocVerificationStatus: input.idDocVerificationStatus,
          slaAcceptedAt: new Date(),
          applicantStatus: 'PENDING_REVIEW',
          referenceId,
        },
      }),
    );

    return {
      referenceId: store.referenceId!,
      storeSlug: store.slug,
      token: signAuthToken({ sub: user.id, role: user.role }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ISLE-103 — Micro/small vendor fast-track applicant
// ─────────────────────────────────────────────────────────────────────────

export interface VendorApplicantInput extends ApplicantAccountInput {
  brandName: string;
  vendorCategory: VendorCategory;
  ownerName: string;
  trn: string;
  whatsappNumber: string;
  parish: Parish;
  addressLine: string;
  primaryProductCategory: string;
  estimatedItemCount: number;
  fulfillmentStrategy: FulfillmentStrategy;
  pickupAddress?: string;
  payoutMethod: PayoutMethod;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  branchCode?: string;
  lynkWalletId?: string;
  govIdDocUrl: string;
  // See DriverApplicantInput's matching comment — populated from the FastAPI
  // OCR check run by the route handler before this is called.
  govIdHolderName?: string;
  govIdExpiry?: Date;
  govIdVerificationStatus?: DocumentVerificationStatus;
}

export async function registerVendorApplicant(input: VendorApplicantInput) {
  if (input.fulfillmentStrategy === 'SELF_DISPATCH' && !input.pickupAddress) {
    throw new HttpError(400, 'Pickup address is required for self-dispatch fulfillment');
  }

  const { lat, lng } = centroidFor(input.parish);
  const slug = await generateUniqueSlug(input.brandName);

  return prisma.$transaction(async (tx) => {
    const user = await createApplicantUser(tx, input, 'STORE');

    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO shops (id, user_id, shop_name, slug, address_line, parish, location)
      VALUES (${id}::uuid, ${user.id}::uuid, ${input.brandName}, ${slug}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    `;

    const shop = await createWithGeneratedReferenceId('SV', (referenceId) =>
      tx.shop.update({
        where: { id },
        data: {
          vendorCategory: input.vendorCategory,
          primaryProductCategory: input.primaryProductCategory,
          ownerName: input.ownerName,
          trn: normalizeTrn(input.trn),
          whatsappNumber: input.whatsappNumber,
          estimatedItemCount: input.estimatedItemCount,
          fulfillmentStrategy: input.fulfillmentStrategy,
          pickupAddress: input.fulfillmentStrategy === 'SELF_DISPATCH' ? input.pickupAddress : null,
          payoutMethod: input.payoutMethod,
          bankName: input.bankName,
          accountHolderName: input.accountHolderName,
          accountNumber: input.accountNumber,
          branchCode: input.branchCode,
          lynkWalletId: input.lynkWalletId,
          govIdDocUrl: input.govIdDocUrl,
          govIdHolderName: input.govIdHolderName,
          govIdExpiry: input.govIdExpiry,
          govIdVerificationStatus: input.govIdVerificationStatus,
          slaAcceptedAt: new Date(),
          // Fast-track path — still PENDING_REVIEW, but the review target is
          // 12–24 hrs rather than the standard queue (surfaced to the
          // applicant on the success screen, not enforced server-side).
          applicantStatus: 'PENDING_REVIEW',
          referenceId,
        },
      }),
    );

    return {
      referenceId: shop.referenceId!,
      shopSlug: shop.slug,
      token: signAuthToken({ sub: user.id, role: user.role }),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// ISLE-104 — Delivery courier / fleet driver applicant
// ─────────────────────────────────────────────────────────────────────────

export interface DriverApplicantInput extends ApplicantAccountInput {
  trn: string;
  whatsappNumber: string;
  homeParish: string;
  homeTown: string;
  vehicleType: DriverVehicleType;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: number;
  licensePlate: string;
  hasColdBox: boolean;
  zoneParishes: string[];
  availability: DriverAvailability;
  payoutMethod: PayoutMethod;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  branchCode?: string;
  lynkWalletId?: string;
  licensePhotoUrl: string;
  insuranceCertUrl: string;
  registrationCertUrl: string;
  // Populated from the FastAPI OCR check (src/lib/ocrClient.ts) run by the
  // route handler before this is called — a document whose OCR result was
  // "expired" never gets here (rejected at the route), so verification
  // status is always VERIFIED, NAME_MISMATCH, or NEEDS_REVIEW by this point.
  // NAME_MISMATCH is stored, not rejected — see verifyRequiredDocument's
  // doc comment for why (name extraction is too error-prone to auto-reject
  // on) — the admin /pending queue surfaces it for a human to check.
  licenseHolderName?: string;
  licenseExpiry?: Date;
  licenseVerificationStatus?: DocumentVerificationStatus;
  insuranceHolderName?: string;
  insuranceCertExpiry?: Date;
  insuranceVerificationStatus?: DocumentVerificationStatus;
  registrationHolderName?: string;
  registrationCertExpiry?: Date;
  registrationVerificationStatus?: DocumentVerificationStatus;
}

export async function registerDriverApplicant(input: DriverApplicantInput) {
  if (input.zoneParishes.length < 1) {
    throw new HttpError(400, 'Select at least one operating zone parish');
  }

  return prisma.$transaction(async (tx) => {
    const user = await createApplicantUser(tx, input, 'DRIVER');

    const driverProfile = await createWithGeneratedReferenceId('DRV', (referenceId) =>
      tx.driverProfile.create({
        data: {
          userId: user.id,
          licenseImageUrl: input.licensePhotoUrl,
          trn: normalizeTrn(input.trn),
          whatsappNumber: input.whatsappNumber,
          homeParish: input.homeParish,
          homeTown: input.homeTown,
          vehicleType: input.vehicleType,
          vehicleMake: input.vehicleMake,
          vehicleModel: input.vehicleModel,
          vehicleYear: input.vehicleYear,
          licensePlate: input.licensePlate,
          hasColdBox: input.hasColdBox,
          zoneParishes: input.zoneParishes,
          availability: input.availability,
          payoutMethod: input.payoutMethod,
          bankName: input.bankName,
          accountHolderName: input.accountHolderName,
          accountNumber: input.accountNumber,
          branchCode: input.branchCode,
          lynkWalletId: input.lynkWalletId,
          licenseHolderName: input.licenseHolderName,
          licenseExpiry: input.licenseExpiry,
          licenseVerificationStatus: input.licenseVerificationStatus,
          insuranceCertUrl: input.insuranceCertUrl,
          insuranceHolderName: input.insuranceHolderName,
          insuranceCertExpiry: input.insuranceCertExpiry,
          insuranceVerificationStatus: input.insuranceVerificationStatus,
          registrationCertUrl: input.registrationCertUrl,
          registrationHolderName: input.registrationHolderName,
          registrationCertExpiry: input.registrationCertExpiry,
          registrationVerificationStatus: input.registrationVerificationStatus,
          applicantStatus: 'PENDING_REVIEW',
          referenceId,
        },
      }),
    );

    return { referenceId: driverProfile.referenceId!, token: signAuthToken({ sub: user.id, role: user.role }) };
  });
}
