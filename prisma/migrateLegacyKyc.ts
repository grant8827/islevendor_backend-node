import 'dotenv/config';
import { migrateLegacyKycDocuments } from '../src/lib/kycDocuments.js';
import { prisma } from '../src/lib/prisma.js';

// Reports every KYC document still referenced at its old public /uploads/…
// location, and with --apply moves each into private-kyc/ and rewrites its
// reference. Must run where the upload files actually live.
//
//   npm run kyc:migrate-legacy            # report only
//   npm run kyc:migrate-legacy -- --apply
const apply = process.argv.includes('--apply');

const documents = await migrateLegacyKycDocuments({ apply });
for (const doc of documents) {
  console.log(`${doc.result.padEnd(22)} ${doc.type}/${doc.id} ${doc.kind}`);
}
console.log(`\n${documents.length} legacy document reference(s) ${apply ? 'processed' : 'found — re-run with --apply to move them'}.`);
await prisma.$disconnect();
process.exit(0);
