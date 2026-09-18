import type { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';
import { findUserByEmail } from '../auth/auth.service.js';

const SALT_ROUNDS = 12;

const memberRoleSchema = z.enum(['ADMIN', 'STAFF']);

const addStaffSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  email: z.string().trim().email(),
  phoneNumber: z.string().trim().min(7, 'Phone number is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: memberRoleSchema,
  // Extra warehouses (beyond the one in the URL) to add this person to in
  // the same step — each must be one the caller is an admin of.
  additionalWarehouseIds: z.array(z.string().uuid()).default([]),
});

const updateStaffSchema = z
  .object({
    role: memberRoleSchema.optional(),
    // Profile details — only for logins this business created (see
    // isManagedBy), never an independent account that was merely added.
    fullName: z.string().trim().min(1, 'Full name is required').optional(),
    phoneNumber: z.string().trim().min(7, 'Phone number is required').optional(),
    email: z.string().trim().email().optional(),
    // Admin-set replacement password — staff have no Profile tab to change
    // their own, so this is how a forgotten/shared password gets replaced.
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });

const MEMBER_SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, fullName: true, email: true, phoneNumber: true, staffOfUserId: true } },
} as const;

type MemberRow = {
  id: string;
  role: 'ADMIN' | 'STAFF';
  createdAt: Date;
  user: { id: string; fullName: string; email: string; phoneNumber: string; staffOfUserId: string | null };
};

// What the dashboard gets per member — `canManage` tells it whether to offer
// editing details / resetting the password (only for logins this owner's
// business created), and staffOfUserId itself stays server-side.
function shapeMember(member: MemberRow, ownerId: string) {
  const { staffOfUserId, ...user } = member.user;
  return { id: member.id, role: member.role, createdAt: member.createdAt, user, canManage: staffOfUserId === ownerId };
}

/**
 * A staff account this owner's admins may edit or reset the password of: one
 * the dashboard created for this owner's business. Never an independent
 * account that merely got added to a warehouse — that would be an account
 * takeover.
 */
function isManagedBy(user: { staffOfUserId: string | null }, ownerId: string) {
  return user.staffOfUserId === ownerId;
}

/**
 * Staff management for a warehouse — GET/POST/PATCH/DELETE
 * /:warehouseId/staff. Every endpoint is admin-only (the owner or an ADMIN
 * member); a plain STAFF login can't even list who else works there.
 */
export function registerStaffRoutes(router: Router) {
  const guard = [requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN)] as const;

  router.get('/:warehouseId/staff', ...guard, async (req, res, next) => {
    try {
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });

      const [owner, members] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: warehouse.userId }, select: { fullName: true, email: true, phoneNumber: true } }),
        prisma.warehouseMember.findMany({
          where: { warehouseId: warehouse.id },
          select: MEMBER_SELECT,
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      res.json({ owner, members: members.map((m) => shapeMember(m, warehouse.userId)) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:warehouseId/staff', ...guard, async (req, res, next) => {
    try {
      const input = addStaffSchema.parse(req.body);
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });

      // The extra warehouses must also be ones the caller administers — and,
      // like the first, part of the same owner's business, so an admin can't
      // hand someone access to a warehouse they don't run.
      const targetIds = [...new Set([warehouse.id, ...input.additionalWarehouseIds])];
      for (const id of targetIds.filter((id) => id !== warehouse.id)) {
        const { warehouse: extra } = await assertWarehouseAccess(id, req.user!, { adminOnly: true });
        if (extra.userId !== warehouse.userId) throw new HttpError(403, "You don't have access to that warehouse");
      }

      const existing = await findUserByEmail(input.email);
      if (existing && existing.role !== UserRole.WAREHOUSE) {
        throw new HttpError(409, "An account with this email already exists and can't be added as warehouse staff");
      }
      if (existing && existing.id === warehouse.userId) {
        throw new HttpError(409, 'That email belongs to the warehouse owner, who already has full access');
      }

      // A previously-removed staff login for this same business can be
      // re-added, and takes the new password. Any other existing warehouse
      // account is added as-is and keeps signing in with its own password.
      const passwordApplied = !existing || isManagedBy(existing, warehouse.userId);

      const result = await prisma.$transaction(async (tx) => {
        let userId: string;
        if (existing) {
          userId = existing.id;
          if (passwordApplied) {
            await tx.user.update({
              where: { id: existing.id },
              data: { passwordHash: await bcrypt.hash(input.password, SALT_ROUNDS) },
            });
          }
        } else {
          const created = await tx.user.create({
            data: {
              email: input.email,
              passwordHash: await bcrypt.hash(input.password, SALT_ROUNDS),
              fullName: input.fullName,
              phoneNumber: input.phoneNumber,
              role: UserRole.WAREHOUSE,
              staffOfUserId: warehouse.userId,
            },
          });
          userId = created.id;
        }

        const alreadyIn = await tx.warehouseMember.findMany({ where: { userId, warehouseId: { in: targetIds } }, select: { warehouseId: true } });
        if (alreadyIn.some((m) => m.warehouseId === warehouse.id)) {
          throw new HttpError(409, 'This person already has access to this warehouse');
        }
        const skip = new Set(alreadyIn.map((m) => m.warehouseId));
        await tx.warehouseMember.createMany({
          data: targetIds.filter((id) => !skip.has(id)).map((warehouseId) => ({ warehouseId, userId, role: input.role })),
        });

        return tx.warehouseMember.findUniqueOrThrow({
          where: { warehouseId_userId: { warehouseId: warehouse.id, userId } },
          select: MEMBER_SELECT,
        });
      });

      res.status(201).json({ member: shapeMember(result, warehouse.userId), passwordApplied });
    } catch (err) {
      next(err);
    }
  });

  async function loadMember(req: { params: Record<string, unknown> }, warehouseId: string) {
    const member = await prisma.warehouseMember.findUnique({
      where: { id: String(req.params.memberId) },
      include: { user: { select: { id: true, staffOfUserId: true } } },
    });
    if (!member || member.warehouseId !== warehouseId) throw new HttpError(404, 'Staff member not found');
    return member;
  }

  router.patch('/:warehouseId/staff/:memberId', ...guard, async (req, res, next) => {
    try {
      const input = updateStaffSchema.parse(req.body);
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      const member = await loadMember(req, warehouse.id);

      if (member.userId === req.user!.sub) throw new HttpError(400, "You can't change your own access");
      const editsAccount = input.password || input.fullName || input.phoneNumber || input.email;
      if (editsAccount && !isManagedBy(member.user, warehouse.userId)) {
        throw new HttpError(403, 'This person has their own account — only they can change their details or password');
      }
      if (input.email) {
        const taken = await findUserByEmail(input.email);
        if (taken && taken.id !== member.userId) throw new HttpError(409, 'Another account already uses this email');
      }

      await prisma.$transaction(async (tx) => {
        if (input.role) await tx.warehouseMember.update({ where: { id: member.id }, data: { role: input.role } });
        if (editsAccount) {
          await tx.user.update({
            where: { id: member.userId },
            data: {
              ...(input.fullName ? { fullName: input.fullName } : {}),
              ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
              ...(input.email ? { email: input.email } : {}),
              ...(input.password ? { passwordHash: await bcrypt.hash(input.password, SALT_ROUNDS) } : {}),
            },
          });
        }
      });

      res.json(shapeMember(await prisma.warehouseMember.findUniqueOrThrow({ where: { id: member.id }, select: MEMBER_SELECT }), warehouse.userId));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:warehouseId/staff/:memberId', ...guard, async (req, res, next) => {
    try {
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      const member = await loadMember(req, warehouse.id);

      if (member.userId === req.user!.sub) throw new HttpError(400, "You can't remove your own access");

      // Only this warehouse's membership goes — the login itself stays (its
      // order/tracking history points at it), it just can't reach anything.
      await prisma.warehouseMember.delete({ where: { id: member.id } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
