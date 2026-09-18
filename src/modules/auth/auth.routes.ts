import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { loginUser, registerUser } from './auth.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1),
  phoneNumber: z.string().min(7),
  role: z.nativeEnum(UserRole),
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const result = await registerUser(input);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string(),
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await loginUser(email, password);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.sub },
      select: {
        id: true,
        email: true,
        fullName: true,
        phoneNumber: true,
        role: true,
        createdAt: true,
        // Set for logins a warehouse admin created via the Staff tab — the
        // dashboard uses it to tell "not added to a warehouse yet" apart
        // from "set up your first warehouse".
        staffOfUserId: true,
        // Only meaningful for DRIVER — lets the driver dashboard tell "no
        // profile yet, go complete onboarding" apart from "profile exists,
        // just no applications yet" without a second round-trip.
        driverProfile: { select: { id: true, applicantStatus: true } },
      },
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

authRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const input = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
    if (!valid) throw new HttpError(400, 'Current password is incorrect');
    if (input.currentPassword === input.newPassword) {
      throw new HttpError(400, 'New password must be different from the current password');
    }

    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    next(err);
  }
});
