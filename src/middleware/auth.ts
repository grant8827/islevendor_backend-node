import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Prisma, type UserRole } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../lib/prisma.js';

export interface AuthTokenPayload {
  sub: string; // user id
  role: UserRole;
  // User.tokenVersion at the time of signing. Absent on tokens issued before
  // session revocation existed, and for brand-new accounts — both mean 0.
  ver?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
}

/**
 * Verifies a login token: signature and expiry, then that it hasn't been
 * revoked — the account still exists and the token was issued under its
 * current tokenVersion (see lib/sessions.ts). Throws if not.
 *
 * The lookup is what makes "sign out everywhere" take effect immediately
 * instead of whenever the token would have expired. Shared by requireAuth
 * and the Socket.IO handshake so the two can't disagree.
 */
export async function verifyAuthToken(token: string): Promise<AuthTokenPayload> {
  const payload = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new Error('Malformed token subject');

  const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { tokenVersion: true } });
  if (!user || user.tokenVersion !== (payload.ver ?? 0)) throw new Error('Token has been revoked');
  return payload;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requires a valid, unrevoked Bearer JWT; attaches req.user. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  let payload: AuthTokenPayload;
  try {
    payload = await verifyAuthToken(header.slice('Bearer '.length));
  } catch (err) {
    // A bad or revoked token is a 401. A database failure during the
    // revocation check is not the caller's fault — let it surface as a 500
    // rather than telling every client its session is invalid.
    if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientInitializationError) return next(err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
  next();
}

/** Requires req.user.role to be one of `roles`. Must run after requireAuth. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role for this action' });
    }
    next();
  };
}
