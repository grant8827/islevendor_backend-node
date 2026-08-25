import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { loginUser, registerUser } from './auth.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
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
    }
    catch (err) {
        next(err);
    }
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});
authRouter.post('/login', async (req, res, next) => {
    try {
        const { email, password } = loginSchema.parse(req.body);
        const result = await loginUser(email, password);
        res.json(result);
    }
    catch (err) {
        next(err);
    }
});
authRouter.get('/me', requireAuth, async (req, res, next) => {
    try {
        const user = await prisma.user.findUniqueOrThrow({
            where: { id: req.user.sub },
            select: { id: true, email: true, fullName: true, phoneNumber: true, role: true, createdAt: true },
        });
        res.json(user);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=auth.routes.js.map