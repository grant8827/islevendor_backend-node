import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { processWiPayPayoutWebhook, withdrawBalance } from './ledger.service.js';
import { getPayoutTiming } from '../../lib/platformSettings.js';
import { registerPayoutAccountRoutes } from './payoutAccount.routes.js';

export const ledgerRouter = Router();

// WiPay's withdrawal notifications (withdrawal.* events) for automated
// payouts. Authenticated by WiPay's signature, not a session — see
// processWiPayPayoutWebhook. Answers 2xx only once the event is durably
// handled, so WiPay retries anything that failed.
ledgerRouter.post('/webhooks/wipay-payouts', async (req, res, next) => {
  try {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (!rawBody) throw new HttpError(400, 'Expected a JSON body');
    res.json(await processWiPayPayoutWebhook(rawBody, req.headers));
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

// Powers the Payout tab's "not yet withdrawn" list — every ledger leg still
// sitting in one of this user's ledger accounts (not yet swept into a
// Payout), whether still in escrow or available. Once withdrawn, a leg drops out of this
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

// How long a withdrawal usually takes to reach the owner's bank — shown on
// every dashboard's Payouts tab before they withdraw.
ledgerRouter.get('/payout-timing', requireAuth, async (_req, res, next) => {
  try {
    res.json(await getPayoutTiming());
  } catch (err) {
    next(err);
  }
});

// Requests a payout of the user's available (released-from-escrow) balance,
// one REQUESTED Payout per account — see ledger.service.ts's withdrawBalance.
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

registerPayoutAccountRoutes(ledgerRouter);
