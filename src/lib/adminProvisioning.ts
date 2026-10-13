import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma.js';

const SALT_ROUNDS = 12; // same as auth.service.ts

export interface NewAdmin {
  email: string;
  fullName: string;
  phoneNumber: string;
}

/**
 * Creates an administrator account — the only way one comes into being,
 * since public registration is CUSTOMER-only (see auth.routes.ts). Meant to
 * be run by an operator with database access (prisma/createAdmin.ts), not
 * exposed over HTTP.
 *
 * The password is generated here and returned once for the operator to hand
 * over; it is never stored or logged in clear. The creation is audited with
 * `provisionedBy` (the operator's OS username) since there's no signed-in
 * actor on a command line.
 */
export async function createAdminAccount(input: NewAdmin, provisionedBy: string): Promise<{ id: string; password: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (existing) throw new Error(`An account with the email ${email} already exists (role: ${existing.role})`);

  const password = crypto.randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, passwordHash, fullName: input.fullName, phoneNumber: input.phoneNumber, role: 'ADMIN' },
    });
    await tx.auditEvent.create({
      data: { action: 'admin.created', targetType: 'user', targetId: created.id, metadata: { via: 'cli', provisionedBy, email } },
    });
    return created;
  });
  return { id: user.id, password };
}
