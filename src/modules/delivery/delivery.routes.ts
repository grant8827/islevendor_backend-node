import { Router, type Request } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';
import { getSocketServer } from '../../lib/socket.js';
import { userRoom } from '../../lib/sessions.js';
import { APPROVED_SELLER } from '../../lib/eligibility.js';

export const deliveryRouter = Router();

// A driver applies to become a regular courier for a warehouse or a shop —
// exactly one of the two, mirroring how Order tells an affiliate leg from a
// store leg (see DeliveryApplication in schema.prisma).
const applySchema = z
  .object({
    warehouseId: z.string().uuid().optional(),
    shopId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.warehouseId) !== Boolean(v.shopId), {
    message: 'Provide exactly one of warehouseId or shopId',
  });

async function requireDriverProfile(userId: string) {
  const driver = await prisma.driverProfile.findUnique({ where: { userId } });
  if (!driver) throw new HttpError(400, 'Complete your driver application before applying to deliver');
  return driver;
}

deliveryRouter.post('/', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = applySchema.parse(req.body);
    const driver = await requireDriverProfile(req.user!.sub);
    // IsleVendor approves a driver first; only then can they apply to
    // individual businesses.
    if (driver.applicantStatus !== 'APPROVED') {
      throw new HttpError(403, 'You can apply to businesses once IsleVendor has approved your driver application');
    }

    const where = input.warehouseId
      ? { driverId_warehouseId: { driverId: driver.id, warehouseId: input.warehouseId } }
      : { driverId_shopId: { driverId: driver.id, shopId: input.shopId! } };

    if (input.warehouseId) {
      const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId, ...APPROVED_SELLER } });
      if (!warehouse) throw new HttpError(404, 'Warehouse not found');
    } else {
      const shop = await prisma.shop.findUnique({ where: { id: input.shopId, ...APPROVED_SELLER } });
      if (!shop) throw new HttpError(404, 'Shop not found');
    }

    const existing = await prisma.deliveryApplication.findUnique({ where });
    if (existing?.status === 'APPROVED') throw new HttpError(409, 'Already approved to deliver for this warehouse/shop');
    if (existing?.status === 'PENDING') throw new HttpError(409, 'Application already pending');

    const application = await prisma.deliveryApplication.upsert({
      where,
      create: { driverId: driver.id, warehouseId: input.warehouseId, shopId: input.shopId },
      update: { status: 'PENDING', decidedAt: null },
    });

    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

// A driver's view of their own applications, across every warehouse/shop.
deliveryRouter.get('/mine', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userId: req.user!.sub } });
    if (!driver) return res.json([]);

    const applications = await prisma.deliveryApplication.findMany({
      where: { driverId: driver.id },
      include: {
        warehouse: { select: { id: true, name: true, parish: true } },
        shop: { select: { id: true, shopName: true, parish: true } },
        // The inbox: how many of the business's messages are unread, and the latest one.
        _count: { select: { messages: { where: { senderSide: 'BUSINESS', readAt: null } } } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { requestedAt: 'desc' },
    });
    res.json(
      applications.map(({ _count, messages, ...application }) => ({
        ...application,
        unreadMessages: _count.messages,
        lastMessage: messages[0] ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

const decideSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
  // Sent to the driver with the decision — a reason, or what happens next.
  message: z.string().trim().max(2000).optional(),
});

const APPLICATION_PARTIES = {
  shop: true,
  warehouse: true,
  driver: { select: { userId: true, user: { select: { fullName: true } } } },
} as const;

async function assertApplicationAccess(applicationId: string, user: NonNullable<Request['user']>) {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) throw new HttpError(404, 'Application not found');
  const application = await prisma.deliveryApplication.findUnique({
    where: { id: applicationId },
    include: APPLICATION_PARTIES,
  });
  if (!application) throw new HttpError(404, 'Application not found');

  if (application.warehouseId) {
    // Owner, admins and staff of the warehouse may all decide applications.
    await assertWarehouseAccess(application.warehouseId, user);
  } else if (application.shop?.userId !== user.sub && user.role !== UserRole.ADMIN) {
    throw new HttpError(403, 'You do not own this warehouse/shop');
  }
  return application;
}

// A warehouse or store operator approves/rejects a pending application, or
// suspends/unsuspends (APPROVED <-> SUSPENDED) an existing courier — mirrors
// authorization.routes.ts's PATCH /:id for reseller applications.
deliveryRouter.patch(
  '/:id',
  requireAuth,
  requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const input = decideSchema.parse(req.body);
      const application = await assertApplicationAccess(String(req.params.id), req.user!);

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.deliveryApplication.update({
          where: { id: application.id },
          data: { status: input.status, decidedAt: new Date() },
        });
        // The driver hears about it in their inbox, in plain words.
        const verdict = {
          APPROVED:
            application.status === 'SUSPENDED'
              ? 'resumed your deliveries.'
              : "approved you to deliver for them. You'll get their pickups while you're online.",
          REJECTED: 'decided not to go ahead with your application.',
          SUSPENDED: 'paused your deliveries for now.',
        }[input.status];
        await tx.applicationMessage.create({
          data: {
            applicationId: application.id,
            senderUserId: req.user!.sub,
            senderSide: 'BUSINESS',
            kind: 'DECISION',
            body: `${businessNameOf(application)} ${verdict}${input.message ? `\n\n${input.message}` : ''}`,
          },
        });
        return result;
      });
      notifyOtherSide(application, 'BUSINESS');
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// Fully revokes a driver's relationship with this warehouse/shop.
deliveryRouter.delete(
  '/:id',
  requireAuth,
  requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const application = await assertApplicationAccess(String(req.params.id), req.user!);
      await prisma.deliveryApplication.delete({ where: { id: application.id } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────
// Talking to an applicant: an in-person interview, a request for more
// information, and messages both ways. The business (anyone who can decide
// its applications) writes as BUSINESS; the driver as DRIVER. Each new
// message is pushed live to the other side — the driver's own socket room,
// or the warehouse/shop room its dashboard joins.
// ─────────────────────────────────────────────────────────────────────────

type ApplicationWithParties = Awaited<ReturnType<typeof assertApplicationAccess>>;

function businessNameOf(application: ApplicationWithParties): string {
  return application.warehouse?.name ?? application.shop?.shopName ?? 'The business';
}

/** The application, and which side of the conversation `user` is on. Throws 404/403 for anyone else. */
async function loadConversation(applicationId: string, user: NonNullable<Request['user']>) {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) throw new HttpError(404, 'Application not found');
  const forDriver = await prisma.deliveryApplication.findUnique({ where: { id: applicationId }, include: APPLICATION_PARTIES });
  if (forDriver && forDriver.driver.userId === user.sub) return { application: forDriver, side: 'DRIVER' as const };
  return { application: await assertApplicationAccess(applicationId, user), side: 'BUSINESS' as const };
}

function notifyOtherSide(application: ApplicationWithParties, from: 'BUSINESS' | 'DRIVER') {
  const room =
    from === 'BUSINESS'
      ? userRoom(application.driver.userId)
      : application.warehouseId
        ? `warehouse_${application.warehouseId}`
        : `shop_${application.shopId}`;
  try {
    getSocketServer().to(room).emit('APPLICATION_MESSAGE', { applicationId: application.id });
  } catch {
    // No socket server (a script) — the message is saved either way.
  }
}

function assertStillOpen(application: ApplicationWithParties) {
  if (application.status === 'REJECTED') throw new HttpError(409, 'This application was turned down — the conversation is closed');
}

const JAMAICA_DATE_TIME = new Intl.DateTimeFormat('en-JM', {
  timeZone: 'America/Jamaica',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
});

const interviewSchema = z.object({
  interviewAt: z.coerce
    .date()
    .refine((d) => d.getTime() > Date.now(), 'Pick a time in the future')
    .refine((d) => d.getTime() < Date.now() + 365 * 24 * 60 * 60 * 1000, 'Pick a time within the next year'),
  location: z.string().trim().min(1, 'Say where the interview is').max(300),
  note: z.string().trim().max(2000).optional(),
});

// The business invites a pending applicant to an in-person interview — or
// moves one already scheduled. The driver gets it as a message.
deliveryRouter.post('/:id/interview', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = interviewSchema.parse(req.body);
    const application = await assertApplicationAccess(String(req.params.id), req.user!);
    if (application.status !== 'PENDING') throw new HttpError(409, 'Interviews are for applications still awaiting a decision');

    const rescheduled = application.interviewAt !== null;
    const message = await prisma.$transaction(async (tx) => {
      await tx.deliveryApplication.update({
        where: { id: application.id },
        data: { interviewAt: input.interviewAt, interviewLocation: input.location },
      });
      return tx.applicationMessage.create({
        data: {
          applicationId: application.id,
          senderUserId: req.user!.sub,
          senderSide: 'BUSINESS',
          kind: 'INTERVIEW_SCHEDULED',
          interviewAt: input.interviewAt,
          interviewLocation: input.location,
          body:
            `${businessNameOf(application)} ${rescheduled ? 'moved your interview to' : 'would like to meet you in person on'} ` +
            `${JAMAICA_DATE_TIME.format(input.interviewAt)} at ${input.location}.` +
            (input.note ? `\n\n${input.note}` : ''),
        },
      });
    });
    notifyOtherSide(application, 'BUSINESS');
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

const requestInfoSchema = z.object({
  message: z.string().trim().min(1, 'Say what you need from the driver').max(2000),
});

// The business asks a pending applicant for something more before deciding.
deliveryRouter.post('/:id/request-info', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { message: body } = requestInfoSchema.parse(req.body);
    const application = await assertApplicationAccess(String(req.params.id), req.user!);
    if (application.status !== 'PENDING') throw new HttpError(409, 'You can only ask for more information before deciding');

    const message = await prisma.$transaction(async (tx) => {
      await tx.deliveryApplication.update({ where: { id: application.id }, data: { infoRequestedAt: new Date() } });
      return tx.applicationMessage.create({
        data: { applicationId: application.id, senderUserId: req.user!.sub, senderSide: 'BUSINESS', kind: 'INFO_REQUESTED', body },
      });
    });
    notifyOtherSide(application, 'BUSINESS');
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// The whole conversation, oldest first. Opening it marks the other side's
// messages as read.
deliveryRouter.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { application, side } = await loadConversation(String(req.params.id), req.user!);
    await prisma.applicationMessage.updateMany({
      where: { applicationId: application.id, senderSide: { not: side }, readAt: null },
      data: { readAt: new Date() },
    });
    const messages = await prisma.applicationMessage.findMany({
      where: { applicationId: application.id },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { fullName: true } } },
    });
    res.json({
      application: {
        id: application.id,
        status: application.status,
        interviewAt: application.interviewAt,
        interviewLocation: application.interviewLocation,
        businessName: businessNameOf(application),
        driverName: application.driver.user.fullName,
      },
      side,
      messages,
    });
  } catch (err) {
    next(err);
  }
});

const messageSchema = z.object({
  body: z.string().trim().min(1, 'Write a message').max(2000),
});

// A plain message from either side — the driver answering a request for
// information, or confirming the interview time.
deliveryRouter.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { body } = messageSchema.parse(req.body);
    const { application, side } = await loadConversation(String(req.params.id), req.user!);
    assertStillOpen(application);

    const message = await prisma.applicationMessage.create({
      data: { applicationId: application.id, senderUserId: req.user!.sub, senderSide: side, body },
      include: { sender: { select: { fullName: true } } },
    });
    notifyOtherSide(application, side);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});
