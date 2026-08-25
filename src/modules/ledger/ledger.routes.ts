import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { processWiPayWebhook } from './ledger.service.js';

export const ledgerRouter = Router();

// WiPay posts here on payment.success / payment.failed. No auth middleware —
// authenticity comes from the hash check inside processWiPayWebhook, not a
// session token (WiPay's servers don't have one).
ledgerRouter.post('/webhooks/wipay', async (req, res, next) => {
  try {
    const result = await processWiPayWebhook(req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

ledgerRouter.get('/accounts/me', requireAuth, async (req, res, next) => {
  try {
    const accounts = await prisma.ledgerAccount.findMany({ where: { userId: req.user!.sub } });
    res.json(accounts);
  } catch (err) {
    next(err);
  }
});
