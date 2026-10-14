import type { PayoutAccount, PayoutMethod, Prisma, PrismaClient } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from './prisma.js';
import { decryptField, encryptField, maskLast4 } from './crypto.js';
import { WIPAY_BANK_NAMES } from './wipayBanks.js';

// Where a person's payouts go (PayoutAccount), and the rules around it.
// Account and ID numbers are only ever stored encrypted; everything shown
// outside an admin's payout view is masked to the last four digits.

/** The owner's own view of their payout details — nothing sensitive in full. */
export function toOwnerView(account: PayoutAccount) {
  return {
    method: account.method,
    bankName: account.bankName,
    bankBranch: account.bankBranch,
    bankAccountType: account.bankAccountType,
    accountNumber: maskLast4(account.accountNumberLast4),
    nameInBank: account.nameInBank,
    lynkWalletId: account.lynkWalletId,
    idType: account.idType,
    hasIdNumber: !!account.idNumberEncrypted,
    email: account.email,
    phone: account.phone,
    readyForAutomaticPayout: missingForAutomaticPayout(account).length === 0,
    missingForAutomaticPayout: missingForAutomaticPayout(account),
    updatedAt: account.updatedAt,
  };
}

/**
 * What WiPay still needs before this account can be paid automatically (a
 * sub_banked withdrawal). Empty means ready. A Lynk wallet can't be — WiPay
 * pays only bank accounts.
 */
export function missingForAutomaticPayout(account: PayoutAccount): string[] {
  if (account.method !== 'BANK') return ['a bank account (WiPay can’t pay Lynk wallets automatically)'];
  const missing: string[] = [];
  if (!account.bankName || !WIPAY_BANK_NAMES.includes(account.bankName)) missing.push('bank');
  if (!account.bankBranch) missing.push('branch');
  if (!account.bankAccountType) missing.push('account type');
  if (!account.accountNumberEncrypted) missing.push('account number');
  if (!account.nameInBank) missing.push('name on the account');
  if (!account.idType || !account.idNumberEncrypted) missing.push('ID type and number');
  if (!account.email) missing.push('email');
  if (!account.phone) missing.push('phone');
  return missing;
}

/** The full details an admin needs to send a manual transfer, or WiPay needs for an automatic one. */
export function revealForPayout(account: PayoutAccount) {
  return {
    method: account.method,
    bankName: account.bankName,
    bankBranch: account.bankBranch,
    bankAccountType: account.bankAccountType,
    accountNumber: account.accountNumberEncrypted ? decryptField(account.accountNumberEncrypted) : null,
    nameInBank: account.nameInBank,
    lynkWalletId: account.lynkWalletId,
    idType: account.idType,
    idNumber: account.idNumberEncrypted ? decryptField(account.idNumberEncrypted) : null,
    email: account.email,
    phone: account.phone,
  };
}

/** What's kept on the payout itself as a record of where it went — masked. */
export function snapshotOf(account: PayoutAccount): Prisma.InputJsonObject {
  return {
    method: account.method,
    bankName: account.bankName,
    bankBranch: account.bankBranch,
    accountNumber: maskLast4(account.accountNumberLast4),
    nameInBank: account.nameInBank,
    lynkWalletId: account.lynkWalletId,
  };
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

interface OnboardingPayoutInput {
  payoutMethod: PayoutMethod;
  bankName?: string;
  accountHolderName?: string;
  accountNumber?: string;
  branchCode?: string;
  lynkWalletId?: string;
}

/**
 * Sign-up's bank details, stored the protected way: encrypted on the
 * applicant's PayoutAccount, with only the masked last four left on the
 * business row. Until PAYOUT_DATA_KEY is configured nothing can be
 * encrypted, so sign-up keeps its old behaviour (plain text on the business
 * row) — `npm run payouts:protect-bank-details` moves those later.
 *
 * Returns what to store in the business row's accountNumber column.
 */
export async function recordOnboardingPayout(
  tx: Prisma.TransactionClient | PrismaClient,
  userId: string,
  input: OnboardingPayoutInput,
  contact: { email: string; phone: string },
): Promise<string | undefined> {
  if (!env.PAYOUT_DATA_KEY) return input.accountNumber;
  const accountNumber = input.accountNumber ? digitsOnly(input.accountNumber) : undefined;
  await tx.payoutAccount.upsert({
    where: { userId },
    create: { userId, ...onboardingFields(input, accountNumber), email: contact.email, phone: toE164(contact.phone) },
    update: {},
  });
  return accountNumber ? (maskLast4(accountNumber.slice(-4)) ?? undefined) : undefined;
}

function onboardingFields(input: OnboardingPayoutInput, accountNumber: string | undefined) {
  return {
    method: input.payoutMethod,
    // Sign-up's bank name was free text; it's kept only if it's one WiPay knows.
    bankName: input.bankName && WIPAY_BANK_NAMES.includes(input.bankName) ? input.bankName : null,
    bankBranch: input.branchCode || null,
    accountNumberEncrypted: accountNumber ? encryptField(accountNumber) : null,
    accountNumberLast4: accountNumber ? accountNumber.slice(-4) : null,
    nameInBank: input.accountHolderName || null,
    lynkWalletId: input.lynkWalletId || null,
  };
}

/** A Jamaican number as E.164 (+1876…), which WiPay requires; null if it can't be read as one. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = digitsOnly(phone);
  if (digits.length === 7) return `+1876${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** The legacy bank details a business row holds, for pre-filling a payout account that doesn't exist yet. */
export async function legacyPayoutDetails(userId: string) {
  const select = { payoutMethod: true, bankName: true, accountHolderName: true, accountNumber: true, branchCode: true, lynkWalletId: true } as const;
  const where = { userId, payoutMethod: { not: null } };
  return (
    (await prisma.warehouse.findFirst({ where, select })) ??
    (await prisma.resellerStore.findFirst({ where, select })) ??
    (await prisma.shop.findFirst({ where, select })) ??
    (await prisma.driverProfile.findFirst({ where, select }))
  );
}
