import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';

export const driversRouter = Router();

// How many days out an expiring document starts showing in the driver's
// login alert popup — see frontend DriverDashboard.jsx.
const EXPIRY_ALERT_WINDOW_DAYS = 7;

type DriverDocumentType = 'license' | 'insurance' | 'registration';

interface DocumentAlert {
  documentType: DriverDocumentType;
  label: string;
  expiryDate: string; // ISO date
  daysUntilExpiry: number; // negative once the document has expired
  isExpired: boolean;
}

const DOCUMENTS: { type: DriverDocumentType; label: string; expiryField: 'licenseExpiry' | 'insuranceCertExpiry' | 'registrationCertExpiry' }[] = [
  { type: 'license', label: "Driver's license", expiryField: 'licenseExpiry' },
  { type: 'insurance', label: 'Certificate of insurance', expiryField: 'insuranceCertExpiry' },
  { type: 'registration', label: 'Certificate of registration', expiryField: 'registrationCertExpiry' },
];

// Whole-day difference, ignoring time-of-day, so "expires today" reads as 0
// regardless of what time the driver happens to log in.
function daysBetween(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / MS_PER_DAY);
}

// A driver's own KYC documents that are expired or expiring within
// EXPIRY_ALERT_WINDOW_DAYS days — the frontend shows these as a popup right
// after login. Deliberately forward-looking only: a document that was
// already expired, or whose name didn't match the applicant, is rejected
// during onboarding (see onboarding.routes.ts's verifyRequiredDocument) and
// never reaches storage, so anything surfaced here became a problem
// *after* it was accepted, purely from the passage of time.
driversRouter.get('/me/document-alerts', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: req.user!.sub },
      select: { licenseExpiry: true, insuranceCertExpiry: true, registrationCertExpiry: true },
    });
    if (!driver) return res.json({ alerts: [] });

    const today = new Date();
    const alerts: DocumentAlert[] = [];

    for (const doc of DOCUMENTS) {
      const expiry = driver[doc.expiryField];
      if (!expiry) continue;

      const daysUntilExpiry = daysBetween(today, expiry);
      if (daysUntilExpiry <= EXPIRY_ALERT_WINDOW_DAYS) {
        alerts.push({
          documentType: doc.type,
          label: doc.label,
          expiryDate: expiry.toISOString().slice(0, 10),
          daysUntilExpiry,
          isExpired: daysUntilExpiry < 0,
        });
      }
    }

    alerts.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// The driver's own Delivery/Delivered tabs (DeliveryPanel.jsx): orders
// assigned to them (Order.driverId — set by dispatch.gateway.ts's
// driver:acceptJob), split by status. `inProgress` is PICKED_UP — accepted
// but not yet handed over; `delivered` is DELIVERED, most recent first,
// capped since a long-tenured driver's full history isn't what this tab is
// for (that's a future "delivery history" concern, not asked for here).
const DELIVERED_HISTORY_LIMIT = 50;

driversRouter.get('/me/deliveries', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const include = {
      customer: { select: { fullName: true, phoneNumber: true } },
      storeListing: { select: { masterProduct: { select: { title: true, imageUrl: true } }, store: { select: { storeName: true } } } },
      shopProduct: { select: { title: true, imageUrl: true, shop: { select: { shopName: true } } } },
    } as const;

    const [inProgress, delivered] = await Promise.all([
      prisma.order.findMany({
        where: { driverId: req.user!.sub, status: 'PICKED_UP' },
        include,
        orderBy: { createdAt: 'asc' }, // oldest-accepted first — first in line to deliver
      }),
      prisma.order.findMany({
        where: { driverId: req.user!.sub, status: 'DELIVERED' },
        include,
        orderBy: { deliveredAt: 'desc' },
        take: DELIVERED_HISTORY_LIMIT,
      }),
    ]);

    const normalize = (o: (typeof inProgress)[number]) => ({
      id: o.id,
      itemTitle: o.storeListing?.masterProduct.title ?? o.shopProduct?.title ?? 'Item no longer available',
      itemImageUrl: o.storeListing?.masterProduct.imageUrl ?? o.shopProduct?.imageUrl ?? null,
      sellerName: o.storeListing?.store.storeName ?? o.shopProduct?.shop.shopName ?? null,
      deliveryAddress: o.deliveryAddress,
      buyerName: o.customer.fullName,
      buyerPhone: o.customer.phoneNumber,
      driverFeeJmd: o.driverFeeJmd,
      createdAt: o.createdAt,
      deliveredAt: o.deliveredAt,
      proofOfDeliveryImageUrl: o.proofOfDeliveryImageUrl,
    });

    res.json({ inProgress: inProgress.map(normalize), delivered: delivered.map(normalize) });
  } catch (err) {
    next(err);
  }
});
