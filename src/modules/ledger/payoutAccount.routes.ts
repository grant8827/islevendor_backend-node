import type { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../lib/audit.js';
import { encryptField, maskLast4 } from '../../lib/crypto.js';
import { legacyPayoutDetails, toE164, toOwnerView } from '../../lib/payoutAccounts.js';
import { WIPAY_BANK_NAMES, WIPAY_ID_TYPES, WIPAY_JAMAICA_BANKS } from '../../lib/wipayBanks.js';

// A person's own payout details — the "Payout details" card on every
// dashboard's Payouts tab. Changing where money goes is exactly what an
// account thief would do first, so every save needs the current password
// and is audited.

const bankSchema = z.object({
  method: z.literal('BANK'),
  bankName: z.enum(WIPAY_BANK_NAMES),
  bankBranch: z.string().trim().min(1, 'Enter your branch').max(255),
  bankAccountType: z.enum(['CHEQUING', 'SAVINGS']),
  // Optional when updating: leaving it out keeps the number already saved.
  accountNumber: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(/^[0-9]{5,20}$/, 'Account number should be 5–20 digits'))
    .optional(),
  nameInBank: z.string().trim().min(1, 'Enter the name on the account').max(255),
});

const lynkSchema = z.object({
  method: z.literal('LYNK_WALLET'),
  lynkWalletId: z.string().trim().min(1, 'Enter your Lynk wallet').max(100),
});

const contactSchema = z.object({
  // Only needed for automatic WiPay payouts — both or neither.
  idType: z.enum(['DRIVER_PERMIT', 'NATIONAL_ID', 'PASSPORT']).optional(),
  idNumber: z.string().trim().toUpperCase().optional(),
  email: z.string().trim().email().max(255).optional(),
  phone: z.string().trim().max(30).optional(),
  currentPassword: z.string().min(1, 'Enter your password to change where your money goes'),
});

const saveSchema = z
  .intersection(z.discriminatedUnion('method', [bankSchema, lynkSchema]), contactSchema)
  .superRefine((v, ctx) => {
    if (v.idNumber && !v.idType) ctx.addIssue({ code: 'custom', path: ['idType'], message: 'Choose the type of ID' });
    if (v.idType && v.idNumber && !WIPAY_ID_TYPES[v.idType].pattern.test(v.idNumber)) {
      ctx.addIssue({ code: 'custom', path: ['idNumber'], message: `That doesn't look like a valid ${WIPAY_ID_TYPES[v.idType].label}` });
    }
    if (v.phone && !toE164(v.phone)) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a Jamaican phone number, e.g. 876-555-1234' });
  });

export function registerPayoutAccountRoutes(router: Router) {
  // The banks and ID types WiPay accepts — for the form's dropdowns.
  router.get('/payout-options', requireAuth, (_req, res) => {
    res.json({
      banks: WIPAY_JAMAICA_BANKS,
      idTypes: Object.entries(WIPAY_ID_TYPES).map(([value, { label }]) => ({ value, label })),
    });
  });

  // The signed-in user's payout details, masked. If they haven't saved any
  // yet, what sign-up recorded is offered to pre-fill the form.
  router.get('/payout-account', requireAuth, async (req, res, next) => {
    try {
      const account = await prisma.payoutAccount.findUnique({ where: { userId: req.user!.sub } });
      if (account) return res.json({ account: toOwnerView(account) });

      const [legacy, user] = await Promise.all([
        legacyPayoutDetails(req.user!.sub),
        prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub }, select: { email: true, phoneNumber: true } }),
      ]);
      res.json({
        account: null,
        prefill: {
          method: legacy?.payoutMethod ?? 'BANK',
          bankName: legacy?.bankName && WIPAY_BANK_NAMES.includes(legacy.bankName) ? legacy.bankName : null,
          bankBranch: legacy?.branchCode ?? null,
          nameInBank: legacy?.accountHolderName ?? null,
          // Never the full number — the owner types it once into the protected record.
          accountNumberHint: legacy?.accountNumber ? maskLast4(legacy.accountNumber.replace(/\D/g, '').slice(-4)) : null,
          lynkWalletId: legacy?.lynkWalletId ?? null,
          email: user.email,
          phone: toE164(user.phoneNumber),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/payout-account', requireAuth, async (req, res, next) => {
    try {
      const input = saveSchema.parse(req.body);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
      if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
        throw new HttpError(400, 'Your password is incorrect');
      }
      const existing = await prisma.payoutAccount.findUnique({ where: { userId: user.id } });

      const bank =
        input.method === 'BANK'
          ? {
              bankName: input.bankName,
              bankBranch: input.bankBranch,
              bankAccountType: input.bankAccountType,
              nameInBank: input.nameInBank,
              ...(input.accountNumber
                ? { accountNumberEncrypted: encryptField(input.accountNumber), accountNumberLast4: input.accountNumber.slice(-4) }
                : {}),
              lynkWalletId: null,
            }
          : { bankName: null, bankBranch: null, bankAccountType: null, accountNumberEncrypted: null, accountNumberLast4: null, nameInBank: null, lynkWalletId: input.lynkWalletId };
      if (input.method === 'BANK' && !input.accountNumber && !existing?.accountNumberEncrypted) {
        throw new HttpError(400, 'Enter your account number');
      }

      const data = {
        method: input.method,
        ...bank,
        ...(input.idType && input.idNumber ? { idType: input.idType, idNumberEncrypted: encryptField(input.idNumber) } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(input.phone ? { phone: toE164(input.phone) } : {}),
      };

      const saved = await prisma.$transaction(async (tx) => {
        const account = await tx.payoutAccount.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
        // What changed, never the numbers themselves.
        await recordAuditEvent(
          req,
          {
            action: 'payout_account.updated',
            targetType: 'user',
            targetId: user.id,
            metadata: {
              method: account.method,
              ...(account.bankName ? { bankName: account.bankName } : {}),
              ...(account.accountNumberLast4 ? { accountNumber: maskLast4(account.accountNumberLast4)! } : {}),
              accountNumberChanged: !!(input.method === 'BANK' && input.accountNumber),
              idNumberChanged: !!input.idNumber,
            },
          },
          tx,
        );
        return account;
      });
      res.json({ account: toOwnerView(saved) });
    } catch (err) {
      next(err);
    }
  });
}
