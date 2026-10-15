import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma.js';
import { getSocketServer } from './socket.js';

// Every socket joins this on connect (see dispatch.gateway.ts), so all of a
// user's live connections can be found — and dropped — by user id.
export function userRoom(userId: string): string {
  return `user_${userId}`;
}

/**
 * Signs a user out everywhere: every login token issued to them so far stops
 * working on its next use, and their open sockets are disconnected. Returns
 * the new token version, for a caller that wants to hand the user a fresh
 * token straight away (a password change keeps the device that made it
 * signed in).
 *
 * Call this from anything that changes what a user is allowed to do or
 * proves they are who they say — a password change, a role change, a
 * suspension — and whenever an account is suspected compromised.
 *
 * Pass `tx` to make the bump part of the same transaction as that change;
 * the caller must then call disconnectUserSockets once it has committed (a
 * socket dropped any earlier could reconnect on the still-valid old token).
 */
export async function revokeUserSessions(userId: string, db: PrismaClient | Prisma.TransactionClient = prisma): Promise<number> {
  const { tokenVersion } = await db.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  if (db === prisma) disconnectUserSockets(userId);
  return tokenVersion;
}

export function disconnectUserSockets(userId: string) {
  try {
    getSocketServer().in(userRoom(userId)).disconnectSockets(true);
  } catch {
    // No socket server in this process (a CLI script) — nothing to drop.
  }
}
