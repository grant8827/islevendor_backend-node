import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { signAuthToken } from '../../middleware/auth.js';
import { normalizeTrn } from '../../lib/trn.js';
import { PARISH_COORDS } from '../../lib/parishes.js';
import { generateUniqueSlug } from '../../lib/slug.js';
import { createWithGeneratedReferenceId } from '../../lib/referenceId.js';
const SALT_ROUNDS = 12;
/**
 * Shared first half of every onboarding flow: create the login-capable User
 * (rejecting a duplicate email same as /auth/register) plus its ledger
 * account, inside the caller's transaction. Every onboarding endpoint calls
 * this, then attaches its role-specific profile row in the same transaction
 * so a half-created applicant (account but no profile, or vice versa) can
 * never happen.
 */
async function createApplicantUser(tx, input, role) {
    const existing = await tx.user.findUnique({ where: { email: input.email } });
    if (existing)
        throw new HttpError(409, 'An account with this email already exists');
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
function centroidFor(parish) {
    return PARISH_COORDS[parish];
}
export async function registerWarehouseApplicant(input) {
    const { lat, lng } = centroidFor(input.parish);
    return prisma.$transaction(async (tx) => {
        const user = await createApplicantUser(tx, input, 'WAREHOUSE');
        const id = randomUUID();
        // Raw INSERT for the base row + spatial point (Prisma can't write a
        // `geometry` column directly — see Warehouse model doc comment).
        await tx.$executeRaw `
      INSERT INTO warehouses (id, user_id, name, address_line, parish, location)
      VALUES (${id}::uuid, ${user.id}::uuid, ${input.hubName}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    `;
        const warehouse = await createWithGeneratedReferenceId('WH', (referenceId) => tx.warehouse.update({
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
        }));
        return { referenceId: warehouse.referenceId, token: signAuthToken({ sub: user.id, role: user.role }) };
    });
}
export async function registerResellerApplicant(input) {
    const slug = await generateUniqueSlug(input.storeName);
    return prisma.$transaction(async (tx) => {
        const user = await createApplicantUser(tx, input, 'RESELLER');
        const store = await createWithGeneratedReferenceId('RS', (referenceId) => tx.resellerStore.create({
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
                slaAcceptedAt: new Date(),
                applicantStatus: 'PENDING_REVIEW',
                referenceId,
            },
        }));
        return {
            referenceId: store.referenceId,
            storeSlug: store.slug,
            token: signAuthToken({ sub: user.id, role: user.role }),
        };
    });
}
export async function registerVendorApplicant(input) {
    if (input.fulfillmentStrategy === 'SELF_DISPATCH' && !input.pickupAddress) {
        throw new HttpError(400, 'Pickup address is required for self-dispatch fulfillment');
    }
    const { lat, lng } = centroidFor(input.parish);
    const slug = await generateUniqueSlug(input.brandName);
    return prisma.$transaction(async (tx) => {
        const user = await createApplicantUser(tx, input, 'STORE');
        const id = randomUUID();
        await tx.$executeRaw `
      INSERT INTO shops (id, user_id, shop_name, slug, address_line, parish, location)
      VALUES (${id}::uuid, ${user.id}::uuid, ${input.brandName}, ${slug}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
    `;
        const shop = await createWithGeneratedReferenceId('SV', (referenceId) => tx.shop.update({
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
                slaAcceptedAt: new Date(),
                // Fast-track path — still PENDING_REVIEW, but the review target is
                // 12–24 hrs rather than the standard queue (surfaced to the
                // applicant on the success screen, not enforced server-side).
                applicantStatus: 'PENDING_REVIEW',
                referenceId,
            },
        }));
        return {
            referenceId: shop.referenceId,
            shopSlug: shop.slug,
            token: signAuthToken({ sub: user.id, role: user.role }),
        };
    });
}
export async function registerDriverApplicant(input) {
    if (input.zoneParishes.length < 1) {
        throw new HttpError(400, 'Select at least one operating zone parish');
    }
    return prisma.$transaction(async (tx) => {
        const user = await createApplicantUser(tx, input, 'DRIVER');
        const driverProfile = await createWithGeneratedReferenceId('DRV', (referenceId) => tx.driverProfile.create({
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
                insuranceCertUrl: input.insuranceCertUrl,
                fitnessCertUrl: input.fitnessCertUrl,
                applicantStatus: 'PENDING_REVIEW',
                referenceId,
            },
        }));
        return { referenceId: driverProfile.referenceId, token: signAuthToken({ sub: user.id, role: user.role }) };
    });
}
//# sourceMappingURL=onboarding.service.js.map