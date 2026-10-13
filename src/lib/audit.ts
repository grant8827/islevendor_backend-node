import type { Request } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Records one privileged action in the append-only audit_events table (see
 * AuditEvent in schema.prisma). Pass a `tx` to make the record part of the
 * same transaction as the action itself, so neither can exist without the
 * other.
 *
 * Deliberately not best-effort: if the audit row can't be written this
 * throws, and the caller's action fails with it. An unaudited privileged
 * action is worse than a failed one.
 */
export async function recordAuditEvent(
  req: Request,
  event: { action: string; targetType: string; targetId: string; metadata?: Prisma.InputJsonObject },
  db: PrismaClient | Prisma.TransactionClient = prisma,
) {
  await db.auditEvent.create({
    data: {
      actorId: req.user?.sub ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata ?? {},
      ipAddress: req.ip ?? null,
    },
  });
}
