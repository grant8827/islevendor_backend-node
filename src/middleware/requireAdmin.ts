import type { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { HttpError } from './errorHandler.js';

/**
 * Requires a *current* administrator. Must run after requireAuth.
 *
 * The role inside a JWT is only what was true when it was signed — an admin
 * who has since been demoted or removed would otherwise keep their access
 * until the token expired — so the account is looked up on each request.
 */
export async function requireCurrentAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = req.user ? await prisma.user.findUnique({ where: { id: req.user.sub }, select: { role: true } }) : null;
    if (user?.role !== UserRole.ADMIN) throw new HttpError(403, 'Administrator access required');
    next();
  } catch (err) {
    next(err);
  }
}
