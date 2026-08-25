import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // The platform commission/driver-holding leg has no owning user — ensure
  // exactly one exists, since ledger.service.ts looks it up unconditionally.
  const existing = await prisma.ledgerAccount.findFirst({ where: { accountType: 'PLATFORM' } });
  if (!existing) {
    await prisma.ledgerAccount.create({ data: { accountType: 'PLATFORM' } });
    console.log('Created PLATFORM ledger account');
  } else {
    console.log('PLATFORM ledger account already exists');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
