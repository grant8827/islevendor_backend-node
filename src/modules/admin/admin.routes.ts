import { Router } from 'express';
import { z } from 'zod';
import { ApplicantStatus, OrderStatus, UserRole, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireCurrentAdmin } from '../../middleware/requireAdmin.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { loadDocumentReferences, type ApplicantType } from '../../lib/kycDocuments.js';
import { recordAuditEvent } from '../../lib/audit.js';
import { disconnectUserSockets, revokeUserSessions } from '../../lib/sessions.js';

// The superadmin console's API (frontend: pages/admin). Mostly read-side so
// far, plus the applicant review flow — the decision itself and the KYC
// document links live with the rest of onboarding, in onboarding.routes.ts.
export const adminRouter = Router();

// Every route below requires a signed-in, *current* administrator.
adminRouter.use(requireAuth, requireCurrentAdmin);

const PAGE_SIZE = 50;
const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);

// ── Overview ────────────────────────────────────────────────────────────────

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const pending = { applicantStatus: ApplicantStatus.PENDING_REVIEW };
    const [warehouses, resellers, vendors, drivers, usersByRole, ordersByStatus] = await Promise.all([
      prisma.warehouse.count({ where: pending }),
      prisma.resellerStore.count({ where: pending }),
      prisma.shop.count({ where: pending }),
      prisma.driverProfile.count({ where: pending }),
      prisma.user.groupBy({ by: ['role'], _count: true }),
      prisma.order.groupBy({ by: ['status'], _count: true }),
    ]);
    res.json({
      pendingApplicants: { warehouse: warehouses, reseller: resellers, 'small-vendor': vendors, driver: drivers },
      usersByRole: Object.fromEntries(usersByRole.map((row) => [row.role, row._count])),
      ordersByStatus: Object.fromEntries(ordersByStatus.map((row) => [row.status, row._count])),
    });
  } catch (err) {
    next(err);
  }
});

// ── Applicants ──────────────────────────────────────────────────────────────

const applicantTypeSchema = z.enum(['warehouse', 'reseller', 'small-vendor', 'driver']);
const applicantUserSelect = { select: { id: true, email: true, fullName: true, phoneNumber: true, createdAt: true } } as const;

interface ApplicantSummary {
  type: ApplicantType;
  id: string;
  name: string;
  referenceId: string | null;
  parish: string | null;
  applicantStatus: ApplicantStatus;
  submittedAt: Date | null;
  user: { id: string; email: string; fullName: string };
  /** OCR checks that came back as anything other than "verified" — what the reviewer should look at first. */
  flags: string[];
}

function flagsOf(checks: Record<string, string | null | undefined>): string[] {
  return Object.entries(checks)
    .filter(([, status]) => status && status !== 'VERIFIED')
    .map(([document, status]) => `${document}: ${status!.toLowerCase().replaceAll('_', ' ')}`);
}

// One queue across all four applicant types, newest submission first.
// ?status= defaults to PENDING_REVIEW; ?type= narrows to one applicant type.
adminRouter.get('/applicants', async (req, res, next) => {
  try {
    const applicantStatus = z.nativeEnum(ApplicantStatus).default('PENDING_REVIEW').parse(req.query.status);
    const type = applicantTypeSchema.optional().parse(req.query.type);
    const where = { applicantStatus };
    const wants = (t: ApplicantType) => !type || type === t;

    const [warehouses, resellers, vendors, drivers] = await Promise.all([
      wants('warehouse') ? prisma.warehouse.findMany({ where, include: { user: applicantUserSelect } }) : [],
      wants('reseller') ? prisma.resellerStore.findMany({ where, include: { user: applicantUserSelect } }) : [],
      wants('small-vendor') ? prisma.shop.findMany({ where, include: { user: applicantUserSelect } }) : [],
      wants('driver') ? prisma.driverProfile.findMany({ where, include: { user: applicantUserSelect } }) : [],
    ]);

    const summary = (
      type: ApplicantType,
      row: { id: string; referenceId: string | null; applicantStatus: ApplicantStatus; slaAcceptedAt: Date | null; user: ApplicantSummary['user'] },
      rest: Pick<ApplicantSummary, 'name' | 'parish' | 'flags'>,
    ): ApplicantSummary => ({
      type,
      id: row.id,
      referenceId: row.referenceId,
      applicantStatus: row.applicantStatus,
      submittedAt: row.slaAcceptedAt,
      user: { id: row.user.id, email: row.user.email, fullName: row.user.fullName },
      ...rest,
    });

    const applicants: ApplicantSummary[] = [
      ...warehouses.map((w) => summary('warehouse', w, { name: w.name, parish: w.parish, flags: [] })),
      ...resellers.map((r) => summary('reseller', r, { name: r.storeName, parish: r.parish, flags: flagsOf({ 'Photo ID': r.idDocVerificationStatus }) })),
      ...vendors.map((v) => summary('small-vendor', v, { name: v.shopName, parish: v.parish, flags: flagsOf({ 'Photo ID': v.govIdVerificationStatus }) })),
      ...drivers.map((d) =>
        summary('driver', d, {
          name: d.user.fullName,
          parish: d.homeParish,
          flags: flagsOf({
            License: d.licenseVerificationStatus,
            Insurance: d.insuranceVerificationStatus,
            Registration: d.registrationVerificationStatus,
          }),
        }),
      ),
    ];
    applicants.sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));
    res.json(applicants);
  } catch (err) {
    next(err);
  }
});

// Columns that are storage references to private documents. Never sent to
// the console — it gets `documents` (which kinds are on file) instead, and
// asks onboarding.routes.ts for a short-lived link to view one.
const DOCUMENT_COLUMNS = new Set([
  'cocjDocUrl',
  'trnCardUrl',
  'proofOfAddressUrl',
  'idDocUrl',
  'govIdDocUrl',
  'licenseImageUrl',
  'selfieImageUrl',
  'insuranceCertUrl',
  'registrationCertUrl',
]);

/** Everything on file for one applicant, minus document references and with the bank account masked. */
function toApplicantProfile(row: Record<string, unknown>) {
  const profile: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (DOCUMENT_COLUMNS.has(key) || key === 'user') continue;
    // Reviewing an application needs to see *that* payout details were
    // given and roughly which account — not the full number.
    profile[key] = key === 'accountNumber' && typeof value === 'string' ? `••••${value.slice(-4)}` : value;
  }
  return profile;
}

adminRouter.get('/applicants/:type/:id', async (req, res, next) => {
  try {
    const type = applicantTypeSchema.parse(req.params.type);
    const id = z.string().uuid().parse(req.params.id);
    const args = { where: { id }, include: { user: applicantUserSelect } };

    const row = await (async () => {
      switch (type) {
        case 'warehouse':
          return prisma.warehouse.findUnique(args);
        case 'reseller':
          return prisma.resellerStore.findUnique(args);
        case 'small-vendor':
          return prisma.shop.findUnique(args);
        case 'driver':
          return prisma.driverProfile.findUnique(args);
      }
    })();
    if (!row) throw new HttpError(404, 'Applicant not found');

    const [references, history] = await Promise.all([
      loadDocumentReferences(type, id),
      prisma.auditEvent.findMany({
        where: { targetType: type, targetId: id },
        orderBy: { createdAt: 'desc' },
        take: PAGE_SIZE,
        include: { actor: { select: { fullName: true, email: true } } },
      }),
    ]);

    res.json({
      type,
      id,
      user: row.user,
      profile: toApplicantProfile(row),
      documents: Object.entries(references ?? {}).map(([kind, reference]) => ({ kind, onFile: reference !== null })),
      history,
    });
  } catch (err) {
    next(err);
  }
});

// ── Users ───────────────────────────────────────────────────────────────────

// ?q= matches name or email (case-insensitive), ?role= narrows by role.
adminRouter.get('/users', async (req, res, next) => {
  try {
    const q = z.string().trim().max(100).optional().parse(req.query.q);
    const role = z.nativeEnum(UserRole).optional().parse(req.query.role);
    const page = pageSchema.parse(req.query.page);

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { fullName: { contains: q, mode: 'insensitive' } }] } : {}),
    };
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, email: true, fullName: true, phoneNumber: true, role: true, createdAt: true },
      }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, users });
  } catch (err) {
    next(err);
  }
});

// Signs a user out of every device — the response to a suspected
// compromised account, or to anything that should take effect before the
// user's current token would expire. Audited in the same transaction.
adminRouter.post('/users/:id/revoke-sessions', async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const reason = z.string().trim().min(1, 'A reason is required').max(500).parse(req.body?.reason);
    if (!(await prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, 'User not found');

    await prisma.$transaction(async (tx) => {
      await revokeUserSessions(id, tx);
      await recordAuditEvent(req, { action: 'user.sessions_revoked', targetType: 'user', targetId: id, metadata: { reason } }, tx);
    });
    disconnectUserSockets(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Orders ──────────────────────────────────────────────────────────────────

// Platform-wide order list, newest first. ?q= is an order id (or the 8-char
// prefix shown everywhere in the UI as "#1a2b3c4d"), ?status= narrows.
adminRouter.get('/orders', async (req, res, next) => {
  try {
    const q = z.string().trim().toLowerCase().regex(/^[0-9a-f-]{1,36}$/, 'Search by order number').optional().parse(req.query.q || undefined);
    const status = z.nativeEnum(OrderStatus).optional().parse(req.query.status);
    const page = pageSchema.parse(req.query.page);

    // Prisma can't prefix-match a uuid column, so a search resolves ids first.
    let ids: string[] | undefined;
    if (q) {
      const matches = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id::text LIKE ${`${q}%`} ORDER BY created_at DESC LIMIT ${PAGE_SIZE}
      `;
      ids = matches.map((m) => m.id);
    }

    const where: Prisma.OrderWhereInput = { ...(status ? { status } : {}), ...(ids ? { id: { in: ids } } : {}) };
    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          status: true,
          quantity: true,
          totalPaidJmd: true,
          createdAt: true,
          deliveredAt: true,
          customer: { select: { fullName: true, email: true } },
          driver: { select: { fullName: true } },
          warehouse: { select: { name: true } },
          resellerStore: { select: { storeName: true } },
          shop: { select: { shopName: true } },
        },
      }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, orders });
  } catch (err) {
    next(err);
  }
});

// ── Audit log ───────────────────────────────────────────────────────────────

adminRouter.get('/audit-events', async (req, res, next) => {
  try {
    const page = pageSchema.parse(req.query.page);
    const action = z.string().trim().max(100).optional().parse(req.query.action || undefined);
    const where: Prisma.AuditEventWhereInput = action ? { action } : {};

    const [total, events] = await Promise.all([
      prisma.auditEvent.count({ where }),
      prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { actor: { select: { fullName: true, email: true } } },
      }),
    ]);
    res.json({ total, page, pageSize: PAGE_SIZE, events });
  } catch (err) {
    next(err);
  }
});
