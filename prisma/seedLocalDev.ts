import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient, type UserRole } from '@prisma/client';

// Local development accounts and a shop to buy from, for trying checkout
// end to end (`npm run seed:local`). Refuses anything but a database on
// this machine. Safe to re-run: existing accounts are left as they are.

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  throw new Error(`seed:local only runs against a local database, not ${url.hostname}`);
}

const prisma = new PrismaClient();
const PASSWORD = 'Passw0rd!';

async function account(email: string, role: UserRole, fullName: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: { email, role, fullName, phoneNumber: '8765550123', passwordHash: await bcrypt.hash(PASSWORD, 12) },
  });
}

async function main() {
  await account('admin@islevendor.local', 'ADMIN', 'Local Admin');
  await account('customer@islevendor.local', 'CUSTOMER', 'Kim Brown');
  const owner = await account('shop@islevendor.local', 'STORE', 'Island Gadgets Owner');

  let shop = await prisma.shop.findFirst({ where: { userId: owner.id } });
  if (!shop) {
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO shops (id, user_id, shop_name, slug, address_line, parish, location, applicant_status)
      VALUES (${id}::uuid, ${owner.id}::uuid, 'Island Gadgets', 'island-gadgets', '12 Hope Road', 'Kingston',
              ST_SetSRID(ST_MakePoint(-76.79, 18.01), 4326), 'APPROVED'::"ApplicantStatus")
    `;
    shop = await prisma.shop.findUniqueOrThrow({ where: { id } });
    const products = [
      { title: 'Bluetooth Speaker', priceJmd: 4500 },
      { title: 'Phone Charger', priceJmd: 1800 },
      { title: 'Wireless Earbuds', priceJmd: 7200 },
    ];
    for (const p of products) {
      await prisma.shopProduct.create({
        data: { shopId: shop.id, sku: `LOCAL-${randomUUID().slice(0, 8)}`, title: p.title, category: 'Electronics', priceJmd: p.priceJmd, stockQuantity: 50 },
      });
    }
  }

  // Every delivery choice, so each can be tried at checkout.
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      offersIsleDash: true,
      offersSellerDelivery: true,
      sellerDeliveryFeeJmd: 800,
      sellerDeliveryNote: 'Delivered in Kingston and St Andrew within 2 days',
      offersPickup: true,
      pickupInstructions: 'Collect at the counter, 9am to 5pm',
    },
  });

  if (!(await prisma.ledgerAccount.findFirst({ where: { userId: owner.id, accountType: 'STORE' } }))) {
    await prisma.ledgerAccount.create({ data: { userId: owner.id, accountType: 'STORE' } });
  }
  if (!(await prisma.ledgerAccount.findFirst({ where: { accountType: 'PLATFORM' } }))) {
    await prisma.ledgerAccount.create({ data: { accountType: 'PLATFORM' } });
  }

  console.log(`Local accounts (password ${PASSWORD}):
  admin@islevendor.local     Superadmin (/admin)
  customer@islevendor.local  customer
  shop@islevendor.local      store owner of "${shop.shopName}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
