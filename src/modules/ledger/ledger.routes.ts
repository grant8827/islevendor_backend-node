import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { processWiPayWebhook, withdrawBalance } from './ledger.service.js';

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

// Powers the Payout tab's "available to withdraw" list — every ledger leg
// still sitting in one of this user's ledger accounts (not yet swept into a
// Payout, not reversed by a refund). Once withdrawn, a leg drops out of this
// list and shows up under its Payout in GET /payouts/me instead.
ledgerRouter.get('/transactions/me', requireAuth, async (req, res, next) => {
  try {
    const accounts = await prisma.ledgerAccount.findMany({ where: { userId: req.user!.sub }, select: { id: true } });
    const transactions = await prisma.ledgerTransaction.findMany({
      where: { recipientAccountId: { in: accounts.map((a) => a.id) }, payoutId: null },
      include: { order: { select: { id: true, status: true, deliveryAddress: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(transactions);
  } catch (err) {
    next(err);
  }
});

// Sweeps everything currently sitting in the user's ledger account(s) into
// one new Payout each — see ledger.service.ts's withdrawBalance.
ledgerRouter.post('/withdraw', requireAuth, async (req, res, next) => {
  try {
    const payouts = await withdrawBalance(req.user!.sub);
    res.status(201).json(payouts);
  } catch (err) {
    next(err);
  }
});

// Powers the Payout History tab — every past withdrawal, each with the
// order-level legs it swept up (so a driver, for instance, can still see
// which delivered package each payout came from). ?month=1-12 and ?year=YYYY
// filter to that period; either can be passed alone.
ledgerRouter.get('/payouts/me', requireAuth, async (req, res, next) => {
  try {
    const accounts = await prisma.ledgerAccount.findMany({ where: { userId: req.user!.sub }, select: { id: true } });

    const year = typeof req.query.year === 'string' ? Number.parseInt(req.query.year, 10) : undefined;
    const month = typeof req.query.month === 'string' ? Number.parseInt(req.query.month, 10) : undefined;
    if (year !== undefined && !Number.isInteger(year)) throw new HttpError(400, 'Invalid year');
    if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) throw new HttpError(400, 'Invalid month');

    let createdAt: { gte: Date; lt: Date } | undefined;
    if (year !== undefined && month !== undefined) {
      createdAt = { gte: new Date(year, month - 1, 1), lt: new Date(year, month, 1) };
    } else if (year !== undefined) {
      createdAt = { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) };
    } else if (month !== undefined) {
      // Month with no year — every occurrence of that month, any year.
      // Simplest to express as a JS filter below rather than a Prisma where.
    }

    let payouts = await prisma.payout.findMany({
      where: {
        ledgerAccountId: { in: accounts.map((a) => a.id) },
        ...(createdAt ? { createdAt } : {}),
      },
      include: { legs: { include: { order: { select: { id: true, status: true } } } } },
      orderBy: { createdAt: 'desc' },
    });

    if (year === undefined && month !== undefined) {
      payouts = payouts.filter((p) => p.createdAt.getMonth() + 1 === month);
    }

    res.json(payouts);
  } catch (err) {
    next(err);
  }
});
