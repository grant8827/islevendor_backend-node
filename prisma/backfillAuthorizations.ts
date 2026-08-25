import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// One-off: approve every (store, warehouse) pair that already has a listing,
// so enabling authorization enforcement doesn't retroactively break existing
// storefronts. New store/warehouse pairings go through the real apply flow.
const prisma = new PrismaClient();

async function main() {
  const pairs = await prisma.$queryRaw<{ store_id: string; warehouse_id: string }[]>`
    SELECT DISTINCT sl.store_id, mp.warehouse_id
    FROM store_listings sl
    JOIN master_products mp ON mp.id = sl.master_product_id
  `;

  for (const { store_id, warehouse_id } of pairs) {
    await prisma.resellerAuthorization.upsert({
      where: { storeId_warehouseId: { storeId: store_id, warehouseId: warehouse_id } },
      create: { storeId: store_id, warehouseId: warehouse_id, status: 'APPROVED', decidedAt: new Date() },
      update: { status: 'APPROVED', decidedAt: new Date() },
    });
    console.log(`approved ${store_id} -> ${warehouse_id}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
