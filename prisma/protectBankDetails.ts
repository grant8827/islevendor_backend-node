import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { env } from '../src/env.js';
import { encryptField, maskLast4 } from '../src/lib/crypto.js';
import { toE164 } from '../src/lib/payoutAccounts.js';
import { WIPAY_BANK_NAMES } from '../src/lib/wipayBanks.js';

// Moves bank account numbers that sign-up stored in plain text (on
// warehouses, reseller stores, shops and driver profiles, before
// PAYOUT_DATA_KEY was set) into each owner's encrypted payout account, then
// replaces the plain-text copy with its masked last four digits.
//
//   npm run payouts:protect-bank-details              # report only
//   npm run payouts:protect-bank-details -- --apply
//
// Needs PAYOUT_DATA_KEY. Safe to re-run: an owner who already has a payout
// account keeps it, and a number already masked is skipped.
const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

if (!env.PAYOUT_DATA_KEY) {
  console.error('PAYOUT_DATA_KEY is not set — nothing can be encrypted.');
  process.exit(1);
}

const select = { id: true, userId: true, payoutMethod: true, bankName: true, accountHolderName: true, accountNumber: true, branchCode: true, lynkWalletId: true, user: { select: { email: true, phoneNumber: true } } } as const;
const tables = [
  ['warehouse', prisma.warehouse],
  ['resellerStore', prisma.resellerStore],
  ['shop', prisma.shop],
  ['driverProfile', prisma.driverProfile],
] as const;

let moved = 0;
for (const [label, table] of tables) {
  // @ts-expect-error — the four delegates share these fields.
  const rows: any[] = await table.findMany({ where: { accountNumber: { not: null } }, select });
  for (const row of rows) {
    const digits = String(row.accountNumber).replace(/\D/g, '');
    if (!digits || String(row.accountNumber).startsWith('••••') || !row.userId) continue;
    console.log(`${apply ? 'protecting' : 'would protect'} ${label} ${row.id} (${maskLast4(digits.slice(-4))})`);
    moved += 1;
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      await tx.payoutAccount.upsert({
        where: { userId: row.userId },
        create: {
          userId: row.userId,
          method: row.payoutMethod ?? 'BANK',
          bankName: row.bankName && WIPAY_BANK_NAMES.includes(row.bankName) ? row.bankName : null,
          bankBranch: row.branchCode,
          accountNumberEncrypted: encryptField(digits),
          accountNumberLast4: digits.slice(-4),
          nameInBank: row.accountHolderName,
          lynkWalletId: row.lynkWalletId,
          email: row.user?.email ?? null,
          phone: toE164(row.user?.phoneNumber),
        },
        update: {},
      });
      // @ts-expect-error — same shape on every table.
      await tx[label].update({ where: { id: row.id }, data: { accountNumber: maskLast4(digits.slice(-4)) } });
    });
  }
}
console.log(`\n${moved} account number(s) ${apply ? 'protected' : 'found — re-run with --apply'}.`);
await prisma.$disconnect();
