import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { Decimal } from 'decimal.js';
import { OrderStatus, PrismaClient } from '@prisma/client';
import { computeAffiliatePricing } from '../src/lib/pricing.js';

const prisma = new PrismaClient();

// Same rounds as auth.service.ts, so these accounts hash/compare identically
// to ones created through real signup.
const SALT_ROUNDS = 12;
const DUMMY_PASSWORD = 'Passw0rd!';

/**
 * Populates every tab of the warehouse dashboard with realistic demo data,
 * built on top of whatever warehouse/reseller/driver already exist (this
 * project's dev DB has exactly one of each — see onboarding's quick-setup
 * forms). Entirely additive and idempotent: re-running skips anything it
 * already created instead of duplicating it, so it's safe to run again
 * after seeding more products, etc.
 *
 * Deliberately scoped to the warehouse dashboard's tabs (Orders, Feedback,
 * Applications, Packing Queue, My Warehouse) — the reseller/shop/driver
 * dashboards aren't touched here.
 */
async function seedWarehouseDashboardDemoData() {
  const warehouse = await prisma.warehouse.findFirst();
  if (!warehouse) {
    console.log('No warehouse found — skipping warehouse dashboard demo data.');
    return;
  }

  const products = await prisma.masterProduct.findMany({ where: { warehouseId: warehouse.id }, take: 3 });
  if (products.length === 0) {
    console.log('Warehouse has no products — skipping order/feedback demo data.');
    return;
  }

  const store = await prisma.resellerStore.findFirst();
  if (!store) {
    console.log('No reseller store found — skipping order/feedback demo data.');
  } else {
    // Approve this store for the warehouse (My Warehouse tab's "Approved
    // Resellers" section needs at least one APPROVED authorization) and list
    // a few of the warehouse's products on it, so there's something to order.
    await prisma.resellerAuthorization.upsert({
      where: { storeId_warehouseId: { storeId: store.id, warehouseId: warehouse.id } },
      create: { storeId: store.id, warehouseId: warehouse.id, status: 'APPROVED', decidedAt: new Date() },
      update: { status: 'APPROVED', decidedAt: new Date() },
    });

    const listings = [];
    for (const product of products) {
      await prisma.resellerProductGrant.upsert({
        where: { storeId_masterProductId: { storeId: store.id, masterProductId: product.id } },
        create: { storeId: store.id, masterProductId: product.id },
        update: {},
      });
      const { retailTotalJmd } = computeAffiliatePricing({
        wholesalePriceJmd: product.wholesalePriceJmd.toString(),
        discountPercent: product.discountPercent,
        resellerCommissionPercent: warehouse.resellerCommissionPercent,
      });
      const listing = await prisma.storeListing.upsert({
        where: { storeId_masterProductId: { storeId: store.id, masterProductId: product.id } },
        create: { storeId: store.id, masterProductId: product.id, retailPriceJmd: retailTotalJmd.toFixed(2) },
        update: { isActive: true, retailPriceJmd: retailTotalJmd.toFixed(2) },
      });
      listings.push({ listing, product });
    }

    const customerEmail = 'dummy.customer@islevendor.test';
    let customer = await prisma.user.findUnique({ where: { email: customerEmail } });
    if (!customer) {
      customer = await prisma.user.create({
        data: {
          email: customerEmail,
          passwordHash: await bcrypt.hash(DUMMY_PASSWORD, SALT_ROUNDS),
          fullName: 'Dummy Customer',
          phoneNumber: '8760000000',
          role: 'CUSTOMER',
        },
      });
      console.log(`Created dummy customer login: ${customerEmail} / ${DUMMY_PASSWORD}`);
    }

    // One of every status, so Orders, Packing Queue (PACKING), and Overview's
    // stat cards all have something to show.
    const ORDER_PLAN: { status: OrderStatus; daysAgo: number }[] = [
      { status: 'AWAITING_PAYMENT', daysAgo: 0 },
      { status: 'PACKING', daysAgo: 1 },
      { status: 'PACKING', daysAgo: 1 },
      { status: 'READY_FOR_PICKUP', daysAgo: 2 },
      { status: 'PICKED_UP', daysAgo: 3 },
      { status: 'DELIVERED', daysAgo: 5 },
      { status: 'DELIVERED', daysAgo: 7 },
      { status: 'CANCELLED', daysAgo: 4 },
    ];

    const existingOrders = await prisma.order.count({ where: { warehouseId: warehouse.id } });
    if (existingOrders > 0) {
      console.log(`Warehouse already has ${existingOrders} order(s) — skipping dummy orders so it stays idempotent.`);
    } else {
      for (const [i, { status, daysAgo }] of ORDER_PLAN.entries()) {
        const { listing, product } = listings[i % listings.length];
        const quantity = 1 + (i % 3);
        const { wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd, retailTotalJmd } = computeAffiliatePricing({
          wholesalePriceJmd: product.wholesalePriceJmd.toString(),
          discountPercent: product.discountPercent,
          resellerCommissionPercent: warehouse.resellerCommissionPercent,
          quantity,
        });
        const driverFee = new Decimal(300);
        const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
        const isDelivered = status === 'DELIVERED';

        const order = await prisma.order.create({
          data: {
            customerId: customer.id,
            resellerStoreId: store.id,
            warehouseId: warehouse.id,
            storeListingId: listing.id,
            quantity,
            totalPaidJmd: retailTotalJmd.plus(driverFee).toFixed(2),
            wholesaleTotalJmd: wholesaleTotalJmd.toFixed(2),
            resellerMarginJmd: resellerMarginJmd.toFixed(2),
            driverFeeJmd: driverFee.toFixed(2),
            platformCommissionJmd: platformCommissionJmd.toFixed(2),
            status,
            deliveryAddress: '12 Dummy Lane, Kingston',
            deliveredAt: isDelivered ? createdAt : null,
            createdAt,
          },
        });

        if (isDelivered) {
          await prisma.productRating.create({
            data: {
              customerId: customer.id,
              orderId: order.id,
              storeListingId: listing.id,
              rating: 4 + (i % 2),
              comment: 'Great quality, arrived on time!',
            },
          });
        }
      }
      console.log(`Created ${ORDER_PLAN.length} dummy orders (with ratings on the delivered ones).`);
    }

    // Ledger legs for the Payouts tab — mirrors ledger.service.ts's
    // processWiPayWebhook AFFILIATE split (warehouse/reseller/platform).
    // Real checkout only creates these off the WiPay webhook, which these
    // directly-inserted seed orders never went through, so backfill them
    // here instead. Scoped to "no legs yet" rather than "just created", so
    // it also tops up orders seeded before this step existed.
    const ordersNeedingLedgerLegs = await prisma.order.findMany({
      where: {
        warehouseId: warehouse.id,
        status: { in: ['PACKING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'] },
        ledgerTxns: { none: {} },
      },
    });

    if (ordersNeedingLedgerLegs.length > 0) {
      const [warehouseAccount, resellerAccount, platformAccount] = await Promise.all([
        prisma.ledgerAccount.findFirstOrThrow({ where: { accountType: 'WAREHOUSE', userId: warehouse.userId } }),
        prisma.ledgerAccount.findFirstOrThrow({ where: { accountType: 'RESELLER', userId: store.userId } }),
        prisma.ledgerAccount.findFirstOrThrow({ where: { accountType: 'PLATFORM' } }),
      ]);

      for (const order of ordersNeedingLedgerLegs) {
        const platformHeld = new Decimal(order.driverFeeJmd.toString()).plus(order.platformCommissionJmd.toString());

        await prisma.ledgerTransaction.createMany({
          data: [
            { orderId: order.id, recipientAccountId: warehouseAccount.id, amountJmd: order.wholesaleTotalJmd, escrowState: 'HELD_IN_ESCROW' },
            { orderId: order.id, recipientAccountId: resellerAccount.id, amountJmd: order.resellerMarginJmd, escrowState: 'HELD_IN_ESCROW' },
            { orderId: order.id, recipientAccountId: platformAccount.id, amountJmd: platformHeld.toFixed(2), escrowState: 'HELD_IN_ESCROW' },
          ],
          skipDuplicates: true,
        });

        await prisma.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.wholesaleTotalJmd} WHERE id = ${warehouseAccount.id}::uuid;
        `;
        await prisma.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${order.resellerMarginJmd} WHERE id = ${resellerAccount.id}::uuid;
        `;
        await prisma.$executeRaw`
          UPDATE ledger_accounts SET pending_balance_jmd = pending_balance_jmd + ${platformHeld.toFixed(2)}::numeric WHERE id = ${platformAccount.id}::uuid;
        `;
      }
      console.log(`Backfilled ledger legs for ${ordersNeedingLedgerLegs.length} order(s) — Payouts tab now has data too.`);
    }

    // Tracking timeline for the Orders tab's Tracking sub-tab — mirrors
    // src/lib/tracking.ts's call sites (orders.routes.ts, ledger.service.ts,
    // dispatch.routes.ts, dispatch.gateway.ts), which these directly-inserted
    // seed orders never passed through, so backfill here instead.
    const STATUS_SEQUENCE: OrderStatus[] = ['AWAITING_PAYMENT', 'PACKING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'];
    const EVENT_NOTES: Record<string, string> = {
      AWAITING_PAYMENT: 'Order placed — awaiting payment',
      PACKING: 'Payment confirmed — now packing',
      READY_FOR_PICKUP: 'Boxed and ready for pickup',
      PICKED_UP: 'Picked up by driver',
      DELIVERED: 'Delivered',
    };

    const ordersNeedingTrackingEvents = await prisma.order.findMany({
      where: { warehouseId: warehouse.id, trackingEvents: { none: {} } },
    });

    if (ordersNeedingTrackingEvents.length > 0) {
      for (const order of ordersNeedingTrackingEvents) {
        // A CANCELLED order (no real trigger produces this status anywhere
        // in the app yet — see dispatch.routes.ts) only ever got as far as
        // being placed, so it stops at index 0.
        const reachedIndex = order.status === 'CANCELLED' ? 0 : STATUS_SEQUENCE.indexOf(order.status);
        const steps = reachedIndex === -1 ? [order.status] : STATUS_SEQUENCE.slice(0, reachedIndex + 1);

        await prisma.orderTrackingEvent.createMany({
          data: steps.map((status, i) => ({
            orderId: order.id,
            status,
            note: EVENT_NOTES[status],
            createdAt: new Date(order.createdAt.getTime() + i * 10 * 60 * 1000),
          })),
        });
      }
      console.log(`Backfilled tracking events for ${ordersNeedingTrackingEvents.length} order(s) — Tracking sub-tab now has data too.`);
    }
  }

  if ((await prisma.vacancy.count({ where: { warehouseId: warehouse.id } })) === 0) {
    await prisma.vacancy.createMany({
      data: [
        {
          warehouseId: warehouse.id,
          title: 'Social media resellers wanted',
          description: 'Looking for Instagram/TikTok sellers to move our home goods line.',
        },
        {
          warehouseId: warehouse.id,
          title: 'Retail partners — Kingston & St. Andrew',
          description: 'Seeking registered businesses to carry our electronics catalog.',
        },
      ],
    });
    console.log('Created 2 dummy vacancies.');
  }

  // A second reseller, left PENDING, so the Applications tab's Applicants
  // sub-tab has something to actually approve/reject.
  const pendingResellerEmail = 'dummy.reseller2@islevendor.test';
  let pendingReseller = await prisma.user.findUnique({ where: { email: pendingResellerEmail } });
  if (!pendingReseller) {
    pendingReseller = await prisma.user.create({
      data: {
        email: pendingResellerEmail,
        passwordHash: await bcrypt.hash(DUMMY_PASSWORD, SALT_ROUNDS),
        fullName: 'Dummy Reseller Two',
        phoneNumber: '8760000001',
        role: 'RESELLER',
      },
    });
    const pendingStore = await prisma.resellerStore.create({
      data: { userId: pendingReseller.id, storeName: 'Dummy Reseller Two Store', slug: 'dummy-reseller-two' },
    });
    await prisma.resellerAuthorization.create({
      data: { storeId: pendingStore.id, warehouseId: warehouse.id, status: 'PENDING' },
    });
    console.log(`Created a second dummy reseller with a pending application: ${pendingResellerEmail} / ${DUMMY_PASSWORD}`);
  }

  // A pending delivery-driver application, for the Applications tab's
  // Delivery Drivers sub-tab.
  const driver = await prisma.driverProfile.findFirst();
  if (driver) {
    await prisma.deliveryApplication.upsert({
      where: { driverId_warehouseId: { driverId: driver.id, warehouseId: warehouse.id } },
      create: { driverId: driver.id, warehouseId: warehouse.id, status: 'PENDING' },
      update: {},
    });
    console.log('Ensured a pending delivery-driver application exists.');
  } else {
    console.log('No driver profile found — skipping delivery application demo data.');
  }
}

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

  await seedWarehouseDashboardDemoData();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
