import 'dotenv/config';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createAdminAccount } from '../src/lib/adminProvisioning.js';
import { prisma } from '../src/lib/prisma.js';

// Creates an administrator account and prints its generated password once.
//
//   npm run admin:create -- --email jane@example.com --name "Jane Doe" --phone 8765551234
//
// Runs against whatever database DATABASE_URL points at — check that first.
const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' } },
});
if (!values.email || !values.name || !values.phone) {
  console.error('Usage: npm run admin:create -- --email <email> --name "<full name>" --phone <phone>');
  process.exit(1);
}

try {
  const { id, password } = await createAdminAccount(
    { email: values.email, fullName: values.name, phoneNumber: values.phone },
    os.userInfo().username,
  );
  console.log(`Created administrator ${values.email} (${id}) on ${new URL(process.env.DATABASE_URL!).host}`);
  console.log(`Temporary password (shown once): ${password}`);
  console.log('Have them sign in at /admin/login and change it straight away.');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
