import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../env.js';
import { reportPayOutcome } from './payments.service.js';

// Called by the IsleVendor Pay service only, never by browsers. Mounted at
// /internal/pay. Works whenever ISLEVENDOR_PAY_SERVICE_TOKEN is set, even
// after PAYMENTS_PROVIDER is switched back to node, so payments IsleVendor
// Pay already started still finish.
export const internalPayRouter = Router();

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest();

function requireServiceToken(req: Request, res: Response, next: NextFunction) {
  const expected = env.ISLEVENDOR_PAY_SERVICE_TOKEN;
  if (!expected) return res.status(503).json({ error: 'IsleVendor Pay is not connected' });
  const presented = req.get('X-IsleVendor-Service-Token') ?? '';
  if (!presented || !crypto.timingSafeEqual(sha256(presented), sha256(expected))) {
    return res.status(401).json({ error: 'Not authorised' });
  }
  next();
}

const outcomeSchema = z.object({
  paymentIntentId: z.string().uuid(),
  status: z.enum(['PAID', 'FAILED']),
  amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/),
  transactionId: z.string().min(1).max(100).nullish(),
  message: z.string().max(500).nullish(),
});

internalPayRouter.post('/payments/:id/outcome', requireServiceToken, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = outcomeSchema.safeParse(req.body);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !parsed.success) return res.status(400).json({ error: 'Invalid outcome' });
    const { transactionId, message, ...rest } = parsed.data;
    res.json(await reportPayOutcome(id, { ...rest, transactionId: transactionId ?? null, message: message ?? null }));
  } catch (err) {
    next(err);
  }
});
