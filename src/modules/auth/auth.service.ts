import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { signAuthToken } from '../../middleware/auth.js';

const SALT_ROUNDS = 12;

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phoneNumber: string;
  role: UserRole;
}

export async function registerUser(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        phoneNumber: input.phoneNumber,
        role: input.role,
      },
    });

    // Every role that can receive money gets a ledger account up front so
    // the ledger engine never has to conditionally create one mid-payout.
    if (['WAREHOUSE', 'RESELLER', 'STORE', 'DRIVER'].includes(input.role)) {
      await tx.ledgerAccount.create({
        data: {
          userId: created.id,
          accountType: input.role as 'WAREHOUSE' | 'RESELLER' | 'STORE' | 'DRIVER',
        },
      });
    }

    return created;
  });

  const token = signAuthToken({ sub: user.id, role: user.role });
  return { user: sanitizeUser(user), token };
}

export async function loginUser(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const token = signAuthToken({ sub: user.id, role: user.role });
  return { user: sanitizeUser(user), token };
}

function sanitizeUser<T extends { passwordHash: string }>(user: T) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}
