import type { Request, Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { env } from '../../env.js';
import { prisma } from '../../lib/prisma.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { recordAuditEvent } from '../../lib/audit.js';
import { maskLast4 } from '../../lib/crypto.js';
import { automatedPayoutsEnabled, cardPaymentsEnabled, effectiveFeeStructure, getPaySettings, updatePaySettings } from '../../lib/platformSettings.js';

// IsleVendor Pay — the Superadmin's payment section (frontend:
// pages/admin/pay). Mounted under /api/admin/pay, so every route already
// requires a current administrator (admin.routes.ts).
//
// Secrets never leave the server: WiPay's API keys and webhook secrets stay
// in the environment, and these routes only ever report whether each one is
// set. What an admin *can* change here — pausing card payments or automated
// payouts, who pays the card fee, IsleVendor's commission — needs their
// password again and is audited.

const PAGE_SIZE = 50;
const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);

/** Financial changes need the admin to re-enter their password. */
async function assertPassword(req: Request, password: unknown) {
  if (typeof password !== 'string' || !password) throw new HttpError(400, 'Enter your password to confirm this change');
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(password, admin.passwordHash))) throw new HttpError(400, 'Your password is incorrect');
}

const sandbox = () => env.WIPAY_ENV === 'sandbox';
const DEFAULT_SANDBOX_PAYMENT_URL = 'https://jmsb.wipayfinancial.com/plugins/payments/request';

/** WiPay's settings as the payment code actually uses them (see modules/payments). */
function wipayEffective() {
  return {
    paymentUrl: env.WIPAY_PAYMENT_URL ?? (sandbox() ? DEFAULT_SANDBOX_PAYMENT_URL : null),
    responseUrl: env.WIPAY_RESPONSE_URL ?? null,
    accountNumberConfigured: !!env.WIPAY_ACCOUNT_NUMBER,
    usingPublicSandboxAccount: sandbox() && !env.WIPAY_ACCOUNT_NUMBER,
  };
}

const FINANCIAL_ACTION_PREFIXES = ['payout.', 'payout_account.', 'ledger.', 'payment.', 'settings.', 'pay.'];

export function registerPayRoutes(router: Router) {
  // ── Payment Overview ──────────────────────────────────────────────────────
  router.get('/pay/overview', async (req, res, next) => {
    try {
      const days = z.coerce.number().int().min(1).max(366).default(30).parse(req.query.days);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const [byStatus, platform, balances, waitingPayouts, refundsNeeded, commission] = await Promise.all([
        prisma.checkoutPayment.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true, _sum: { amountJmd: true } }),
        prisma.ledgerAccount.findFirst({ where: { accountType: 'PLATFORM' } }),
        prisma.ledgerAccount.aggregate({ where: { accountType: { not: 'PLATFORM' } }, _sum: { pendingBalanceJmd: true, availableBalanceJmd: true } }),
        prisma.payout.aggregate({ where: { status: { in: ['REQUESTED', 'APPROVED', 'SUBMITTED', 'PROCESSING'] } }, _count: true, _sum: { amountJmd: true } }),
        prisma.checkoutPayment.count({ where: { status: 'DUPLICATE' } }),
        prisma.order.aggregate({
          where: { createdAt: { gte: since }, status: { notIn: ['AWAITING_PAYMENT', 'CANCELLED', 'REFUNDED'] } },
          _sum: { platformCommissionJmd: true, totalPaidJmd: true },
          _count: true,
        }),
      ]);
      res.json({
        days,
        payments: Object.fromEntries(byStatus.map((r) => [r.status, { count: r._count, amountJmd: r._sum.amountJmd ?? 0 }])),
        paidOrders: { count: commission._count, salesJmd: commission._sum.totalPaidJmd ?? 0, commissionJmd: commission._sum.platformCommissionJmd ?? 0 },
        platformBalance: platform ? { pendingJmd: platform.pendingBalanceJmd, availableJmd: platform.availableBalanceJmd } : null,
        vendorBalances: { pendingJmd: balances._sum.pendingBalanceJmd ?? 0, availableJmd: balances._sum.availableBalanceJmd ?? 0 },
        payoutsWaiting: { count: waitingPayouts._count, amountJmd: waitingPayouts._sum.amountJmd ?? 0 },
        refundsNeeded,
        cardPaymentsLive: await cardPaymentsEnabled(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Payment Gateways: what's available, and the admin's on/off switches ─────
  router.get('/pay/gateways', async (_req, res, next) => {
    try {
      const settings = await getPaySettings();
      const w = wipayEffective();
      const paymentMissing = [
        !w.paymentUrl && 'payment address (WIPAY_PAYMENT_URL)',
        !sandbox() && !env.WIPAY_ACCOUNT_NUMBER && 'merchant account number',
        !sandbox() && !env.WIPAY_API_KEY && 'API key',
      ].filter(Boolean);
      const payoutMissing = [
        !env.WIPAY_PAYOUT_API_URL && 'withdrawal API address',
        !env.WIPAY_PAYOUT_API_KEY && 'WAPI key',
        !env.WIPAY_PAYOUT_WEBHOOK_SECRET && 'payout webhook secret',
        !env.PAYOUT_DATA_KEY && 'payout details encryption key',
      ].filter(Boolean);
      res.json([
        {
          id: 'wipay-payments',
          name: 'WiPay card payments',
          environment: env.WIPAY_ENV,
          deployEnabled: env.ENABLE_WIPAY_WEBHOOKS,
          adminEnabled: settings.paymentsEnabled,
          active: (await cardPaymentsEnabled()) && paymentMissing.length === 0,
          missing: paymentMissing,
        },
        {
          id: 'wipay-payouts',
          name: 'WiPay automatic payouts',
          environment: env.WIPAY_PAYOUT_API_URL ? (new URL(env.WIPAY_PAYOUT_API_URL).hostname.includes('sb.') ? 'sandbox' : 'live') : null,
          deployEnabled: env.ENABLE_AUTOMATED_PAYOUTS,
          adminEnabled: settings.automatedPayoutsEnabled,
          active: await automatedPayoutsEnabled(),
          liveAuthorized: env.WIPAY_PAYOUTS_LIVE_AUTHORIZED,
          missing: payoutMissing,
        },
        { id: 'manual-payouts', name: 'Manual payouts (bank or Lynk transfer)', deployEnabled: true, adminEnabled: true, active: true, missing: [] },
      ]);
    } catch (err) {
      next(err);
    }
  });

  const switchesSchema = z.object({
    paymentsEnabled: z.boolean().optional(),
    automatedPayoutsEnabled: z.boolean().optional(),
    currentPassword: z.string(),
  });

  // Pause or resume card payments / automated payouts. These only narrow the
  // deployment's switches — they can't turn on what the deployment has off.
  router.patch('/pay/gateways', async (req, res, next) => {
    try {
      const { currentPassword, ...changes } = switchesSchema.parse(req.body);
      await assertPassword(req, currentPassword);
      const before = await getPaySettings();
      const after = await prisma.$transaction(async (tx) => {
        const updated = await updatePaySettings(changes, req.user!.sub, tx);
        await recordAuditEvent(
          req,
          {
            action: 'settings.gateways_changed',
            targetType: 'platform_settings',
            targetId: 'default',
            metadata: {
              before: { paymentsEnabled: before.paymentsEnabled, automatedPayoutsEnabled: before.automatedPayoutsEnabled },
              after: { paymentsEnabled: updated.paymentsEnabled, automatedPayoutsEnabled: updated.automatedPayoutsEnabled },
            },
          },
          tx,
        );
        return updated;
      });
      res.json({ paymentsEnabled: after.paymentsEnabled, automatedPayoutsEnabled: after.automatedPayoutsEnabled });
    } catch (err) {
      next(err);
    }
  });

  // ── WiPay Configuration ───────────────────────────────────────────────────
  router.get('/pay/wipay', async (_req, res, next) => {
    try {
      const settings = await getPaySettings();
      const w = wipayEffective();
      res.json({
        environment: env.WIPAY_ENV,
        merchantAccount: env.WIPAY_ACCOUNT_NUMBER ? maskLast4(env.WIPAY_ACCOUNT_NUMBER.slice(-4)) : w.usingPublicSandboxAccount ? "WiPay's public sandbox account" : null,
        paymentUrl: w.paymentUrl,
        responseUrl: w.responseUrl,
        countryCode: env.WIPAY_COUNTRY_CODE,
        currency: env.WIPAY_CURRENCY,
        origin: env.WIPAY_ORIGIN,
        feeStructure: { effective: await effectiveFeeStructure(), fromEnvironment: env.WIPAY_FEE_STRUCTURE, adminOverride: settings.wipayFeeStructure },
        // Only whether each secret is set — never the value.
        secrets: {
          apiKey: !!env.WIPAY_API_KEY,
          paymentsWebhookSecret: !!env.WIPAY_WEBHOOK_SECRET,
          payoutApiKey: !!env.WIPAY_PAYOUT_API_KEY,
          payoutWebhookSecret: !!env.WIPAY_PAYOUT_WEBHOOK_SECRET,
          payoutDataKey: !!env.PAYOUT_DATA_KEY,
        },
        payoutApiUrl: env.WIPAY_PAYOUT_API_URL ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  const feeSchema = z.object({
    // null clears the override and goes back to WIPAY_FEE_STRUCTURE.
    feeStructure: z.enum(['merchant_absorb', 'customer_pay', 'split']).nullable(),
    currentPassword: z.string(),
  });

  // Who pays WiPay's card fee, for payments started from now on.
  router.patch('/pay/wipay', async (req, res, next) => {
    try {
      const { feeStructure, currentPassword } = feeSchema.parse(req.body);
      await assertPassword(req, currentPassword);
      const before = await effectiveFeeStructure();
      await prisma.$transaction(async (tx) => {
        await updatePaySettings({ wipayFeeStructure: feeStructure }, req.user!.sub, tx);
        await recordAuditEvent(
          req,
          { action: 'settings.card_fee_changed', targetType: 'platform_settings', targetId: 'default', metadata: { before, after: feeStructure ?? env.WIPAY_FEE_STRUCTURE } },
          tx,
        );
      });
      res.json({ effective: await effectiveFeeStructure() });
    } catch (err) {
      next(err);
    }
  });

  // Checks WiPay can be reached with the configured addresses and key, without
  // charging anything or creating a checkout session.
  router.post('/pay/wipay/test', async (req, res, next) => {
    try {
      const probe = async (name: string, fn: () => Promise<string>) => {
        try {
          return { name, ok: true, detail: await fn() };
        } catch (err) {
          return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      };
      const get = async (url: string, headers: Record<string, string> = {}) => {
        const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(8000) });
        return response;
      };
      const w = wipayEffective();
      const results = await Promise.all([
        probe('Checkout server reachable', async () => {
          if (!w.paymentUrl) throw new Error('No payment address configured');
          const response = await get(new URL(w.paymentUrl).origin);
          return `Answered (${response.status})`;
        }),
        probe('Withdrawal API reachable', async () => {
          if (!env.WIPAY_PAYOUT_API_URL) throw new Error('No withdrawal API address configured');
          const response = await get(`${env.WIPAY_PAYOUT_API_URL.replace(/\/$/, '')}/withdrawals/meta`);
          if (!response.ok) throw new Error(`WiPay returned ${response.status}`);
          return 'Metadata returned';
        }),
        probe('WAPI key accepted', async () => {
          if (!env.WIPAY_PAYOUT_API_URL || !env.WIPAY_PAYOUT_API_KEY) throw new Error('No WAPI key configured');
          const response = await get(`${env.WIPAY_PAYOUT_API_URL.replace(/\/$/, '')}/withdrawals?page_size=1`, { 'X-WAPI-Key': env.WIPAY_PAYOUT_API_KEY });
          if (response.status === 401 || response.status === 403) throw new Error('WiPay refused the key');
          if (!response.ok) throw new Error(`WiPay returned ${response.status}`);
          return 'Key accepted';
        }),
      ]);
      await recordAuditEvent(req, {
        action: 'pay.connection_tested',
        targetType: 'gateway',
        targetId: 'wipay',
        metadata: { results: results.map((r) => ({ name: r.name, ok: r.ok })) },
      });
      res.json({ testedAt: new Date(), results });
    } catch (err) {
      next(err);
    }
  });

  // ── Gateway Links ─────────────────────────────────────────────────────────
  // Every address payments depend on, what kind it is, and whether it passes
  // the rules: HTTPS; WiPay addresses on WiPay's own domain and matching the
  // environment; our return and webhook addresses on our own API. They're set
  // in the deployment, not here, so a dashboard change can never redirect money.
  router.get('/pay/links', async (req, res, next) => {
    try {
      const apiOrigin = `${req.protocol}://${req.get('host')}`;
      const check = (url: string | null, kind: 'provider' | 'ours') => {
        const problems: string[] = [];
        if (!url) return { status: 'missing' as const, problems: ['Not set'] };
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return { status: 'error' as const, problems: ['Not a valid address'] };
        }
        if (parsed.protocol !== 'https:') problems.push('Should use https');
        if (kind === 'provider') {
          if (!parsed.hostname.endsWith('.wipayfinancial.com')) problems.push("Not on WiPay's domain (wipayfinancial.com)");
          else if (parsed.hostname.includes('sb.') !== sandbox()) problems.push(`WiPay ${parsed.hostname.includes('sb.') ? 'sandbox' : 'live'} address, but the environment is ${env.WIPAY_ENV}`);
        }
        return { status: problems.length ? ('warning' as const) : ('ok' as const), problems };
      };
      const w = wipayEffective();
      const links = [
        { label: 'Hosted checkout (WiPay)', kind: 'Hosted checkout URL', url: w.paymentUrl, ...check(w.paymentUrl, 'provider'), setting: 'WIPAY_PAYMENT_URL' },
        { label: 'Withdrawal API (WiPay)', kind: 'Provider API URL', url: env.WIPAY_PAYOUT_API_URL ?? null, ...check(env.WIPAY_PAYOUT_API_URL ?? null, 'provider'), setting: 'WIPAY_PAYOUT_API_URL' },
        { label: 'Customer return', kind: 'Customer return URL', url: w.responseUrl, ...check(w.responseUrl, 'ours'), setting: 'WIPAY_RESPONSE_URL' },
        { label: 'Payment status page', kind: 'Marketplace URL', url: env.PUBLIC_WEB_URL ? `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}/payment/{id}` : null, ...check(env.PUBLIC_WEB_URL ?? null, 'ours'), setting: 'PUBLIC_WEB_URL' },
        // Generated by this server — registered in WiPay's Developer page, never typed in.
        { label: 'Payments webhook', kind: 'Webhook endpoint', url: `${apiOrigin}/api/webhooks/wipay`, ...check(`${apiOrigin}/api/webhooks/wipay`, 'ours'), generated: true },
        { label: 'Payout webhook', kind: 'Webhook endpoint', url: `${apiOrigin}/api/ledger/webhooks/wipay-payouts`, ...check(`${apiOrigin}/api/ledger/webhooks/wipay-payouts`, 'ours'), generated: true },
        { label: 'Marketplace API', kind: 'Internal marketplace API URL', url: `${apiOrigin}/api`, ...check(`${apiOrigin}/api`, 'ours'), generated: true },
      ];
      // The return address has to land on this API's WiPay return route.
      const ret = links[2];
      if (ret.url && !new URL(ret.url).pathname.endsWith('/api/webhooks/wipay')) {
        ret.problems.push('Must point to this API’s /api/webhooks/wipay');
        ret.status = 'error';
      }
      res.json(links);
    } catch (err) {
      next(err);
    }
  });

  // ── Transactions ──────────────────────────────────────────────────────────
  router.get('/pay/transactions', async (req, res, next) => {
    try {
      const status = z.enum(['PENDING', 'PAID', 'FAILED', 'SUPERSEDED', 'DUPLICATE', 'REFUNDED']).optional().parse(req.query.status || undefined);
      const q = z.string().trim().max(100).optional().parse(req.query.q || undefined);
      const page = pageSchema.parse(req.query.page);
      const where: Prisma.CheckoutPaymentWhereInput = {
        ...(status ? { status } : {}),
        ...(q
          ? {
              OR: [
                { reference: { contains: q, mode: 'insensitive' } },
                { wipayTransactionId: { contains: q, mode: 'insensitive' } },
                { customer: { email: { contains: q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      };
      const [total, payments] = await Promise.all([
        prisma.checkoutPayment.count({ where }),
        prisma.checkoutPayment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { customer: { select: { fullName: true, email: true } } },
        }),
      ]);
      res.json({ total, page, pageSize: PAGE_SIZE, payments });
    } catch (err) {
      next(err);
    }
  });

  // ── Marketplace Commissions ───────────────────────────────────────────────
  router.get('/pay/commissions', async (_req, res, next) => {
    try {
      const settings = await getPaySettings();
      // What IsleVendor earned in commission, month by month, on paid orders.
      const byMonth = await prisma.$queryRaw<{ month: Date; orders: bigint; commission: Prisma.Decimal; sales: Prisma.Decimal }[]>`
        SELECT date_trunc('month', created_at) AS month, COUNT(*) AS orders,
               COALESCE(SUM(platform_commission_jmd), 0) AS commission, COALESCE(SUM(total_paid_jmd), 0) AS sales
        FROM orders
        WHERE status NOT IN ('AWAITING_PAYMENT', 'CANCELLED', 'REFUNDED')
          AND created_at >= date_trunc('month', now()) - interval '11 months'
        GROUP BY 1 ORDER BY 1 DESC
      `;
      const history = await prisma.auditEvent.findMany({
        where: { action: 'settings.commission_changed' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { actor: { select: { fullName: true } } },
      });
      res.json({
        platformCommissionPercent: settings.platformCommissionPercent,
        byMonth: byMonth.map((m) => ({ month: m.month, orders: Number(m.orders), commissionJmd: m.commission, salesJmd: m.sales })),
        history,
      });
    } catch (err) {
      next(err);
    }
  });

  const commissionSchema = z.object({ percent: z.number().min(0).max(50), currentPassword: z.string() });

  // IsleVendor's commission, for orders placed from now on. Prices shown in
  // the marketplace change with it; orders already placed keep theirs.
  router.put('/pay/commissions', async (req, res, next) => {
    try {
      const { percent, currentPassword } = commissionSchema.parse(req.body);
      await assertPassword(req, currentPassword);
      const before = (await getPaySettings()).platformCommissionPercent;
      const rounded = new Decimal(percent).toDecimalPlaces(2).toNumber();
      await prisma.$transaction(async (tx) => {
        await updatePaySettings({ platformCommissionPercent: rounded }, req.user!.sub, tx);
        await recordAuditEvent(
          req,
          { action: 'settings.commission_changed', targetType: 'platform_settings', targetId: 'default', metadata: { beforePercent: before.toNumber(), afterPercent: rounded } },
          tx,
        );
      });
      res.json({ platformCommissionPercent: rounded });
    } catch (err) {
      next(err);
    }
  });

  // ── Vendor Earnings ───────────────────────────────────────────────────────
  router.get('/pay/earnings', async (req, res, next) => {
    try {
      const type = z.enum(['WAREHOUSE', 'RESELLER', 'STORE', 'DRIVER']).optional().parse(req.query.type || undefined);
      const page = pageSchema.parse(req.query.page);
      const where: Prisma.LedgerAccountWhereInput = { accountType: type ?? { not: 'PLATFORM' } };
      const [total, accounts] = await Promise.all([
        prisma.ledgerAccount.count({ where }),
        prisma.ledgerAccount.findMany({
          where,
          orderBy: [{ availableBalanceJmd: 'desc' }, { pendingBalanceJmd: 'desc' }],
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: { user: { select: { fullName: true, email: true } } },
        }),
      ]);
      const paidOut = await prisma.payout.groupBy({
        by: ['ledgerAccountId'],
        where: { ledgerAccountId: { in: accounts.map((a) => a.id) }, status: 'PAID' },
        _sum: { amountJmd: true },
      });
      const paidOutBy = new Map(paidOut.map((p) => [p.ledgerAccountId, p._sum.amountJmd ?? 0]));
      res.json({
        total,
        page,
        pageSize: PAGE_SIZE,
        accounts: accounts.map((a) => ({
          id: a.id,
          accountType: a.accountType,
          owner: a.user,
          pendingJmd: a.pendingBalanceJmd,
          availableJmd: a.availableBalanceJmd,
          paidOutJmd: paidOutBy.get(a.id) ?? 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Refunds and Chargebacks ───────────────────────────────────────────────
  router.get('/pay/refunds', async (_req, res, next) => {
    try {
      const [payments, orderRefunds] = await Promise.all([
        prisma.checkoutPayment.findMany({
          where: { status: { in: ['DUPLICATE', 'REFUNDED'] } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { customer: { select: { fullName: true, email: true } } },
        }),
        prisma.refund.findMany({
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { order: { select: { id: true, totalPaidJmd: true, wipayTransactionId: true } }, initiator: { select: { fullName: true } } },
        }),
      ]);
      res.json({ payments, orderRefunds });
    } catch (err) {
      next(err);
    }
  });

  const markRefundedSchema = z.object({ reference: z.string().trim().min(1, 'Enter WiPay’s refund reference').max(200), currentPassword: z.string() });

  // Record that a payment needing a refund (a DUPLICATE) was refunded in
  // WiPay's dashboard. Only a DUPLICATE, once.
  router.post('/pay/refunds/:paymentId', async (req, res, next) => {
    try {
      const paymentId = z.string().uuid().parse(req.params.paymentId);
      const { reference, currentPassword } = markRefundedSchema.parse(req.body);
      await assertPassword(req, currentPassword);
      const payment = await prisma.$transaction(async (tx) => {
        const updated = await tx.checkoutPayment.updateMany({
          where: { id: paymentId, status: 'DUPLICATE' },
          data: { status: 'REFUNDED', refundReference: reference, refundedAt: new Date(), refundedBy: req.user!.sub },
        });
        if (updated.count === 0) throw new HttpError(409, 'Only a payment marked as needing a refund can be marked refunded');
        const row = await tx.checkoutPayment.findUniqueOrThrow({ where: { id: paymentId } });
        await recordAuditEvent(req, { action: 'payment.refunded', targetType: 'checkout_payment', targetId: paymentId, metadata: { amountJmd: row.amountJmd.toFixed(2), reference } }, tx);
        return row;
      });
      res.json(payment);
    } catch (err) {
      next(err);
    }
  });

  // ── Financial Reports (CSV) ───────────────────────────────────────────────
  router.get('/pay/reports/:type', async (req, res, next) => {
    try {
      const type = z.enum(['transactions', 'ledger', 'payouts', 'commissions']).parse(req.params.type);
      const from = z.coerce.date().optional().parse(req.query.from || undefined) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = z.coerce.date().optional().parse(req.query.to || undefined) ?? new Date();
      const range = { gte: from, lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) };

      let header: string[];
      let rows: unknown[][];
      if (type === 'transactions') {
        const payments = await prisma.checkoutPayment.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, include: { customer: { select: { email: true } } } });
        header = ['created_at', 'reference', 'wipay_transaction_id', 'status', 'amount_jmd', 'customer_email', 'orders', 'paid_at', 'refund_reference'];
        rows = payments.map((p) => [p.createdAt.toISOString(), p.reference, p.wipayTransactionId, p.status, p.amountJmd.toFixed(2), p.customer.email, p.orderIds.join(' '), p.paidAt?.toISOString(), p.refundReference]);
      } else if (type === 'ledger') {
        const legs = await prisma.ledgerTransaction.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, include: { recipientAccount: { include: { user: { select: { email: true } } } } } });
        header = ['created_at', 'order_id', 'account_type', 'account_email', 'amount_jmd', 'state', 'reversed_at', 'payout_id'];
        rows = legs.map((l) => [l.createdAt.toISOString(), l.orderId, l.recipientAccount.accountType, l.recipientAccount.user?.email ?? 'IsleVendor', l.amountJmd.toFixed(2), l.escrowState, l.reversedAt?.toISOString(), l.payoutId]);
      } else if (type === 'payouts') {
        const payouts = await prisma.payout.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, include: { ledgerAccount: { include: { user: { select: { email: true } } } } } });
        header = ['created_at', 'payout_id', 'account_type', 'account_email', 'amount_jmd', 'status', 'channel', 'reference', 'wipay_transaction_id', 'wipay_fee_jmd', 'settled_at'];
        rows = payouts.map((p) => [p.createdAt.toISOString(), p.id, p.ledgerAccount.accountType, p.ledgerAccount.user?.email ?? 'IsleVendor', p.amountJmd.toFixed(2), p.status, p.channel, p.reference, p.providerTransactionId, p.providerFeeJmd?.toFixed(2), p.settledAt?.toISOString()]);
      } else {
        const orders = await prisma.order.findMany({ where: { createdAt: range, status: { notIn: ['AWAITING_PAYMENT', 'CANCELLED'] } }, orderBy: { createdAt: 'asc' } });
        header = ['created_at', 'order_id', 'status', 'total_paid_jmd', 'platform_commission_jmd', 'driver_fee_jmd', 'seller_delivery_fee_jmd', 'wholesale_jmd', 'reseller_margin_jmd'];
        rows = orders.map((o) => [o.createdAt.toISOString(), o.id, o.status, o.totalPaidJmd.toFixed(2), o.platformCommissionJmd.toFixed(2), o.driverFeeJmd.toFixed(2), o.sellerDeliveryFeeJmd.toFixed(2), o.wholesaleTotalJmd.toFixed(2), o.resellerMarginJmd.toFixed(2)]);
      }

      await recordAuditEvent(req, { action: 'pay.report_exported', targetType: 'report', targetId: type, metadata: { from: from.toISOString(), to: to.toISOString(), rows: rows.length } });
      // Quote every cell; neutralise a leading = + - @ so a spreadsheet can't run it as a formula.
      const cell = (v: unknown) => {
        const text = v === null || v === undefined ? '' : String(v);
        return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
      };
      const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="islevendor-${type}-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });
}

/** The audit-log filter for IsleVendor Pay's Audit Logs: every money-related action. */
export const FINANCIAL_AUDIT_FILTER: Prisma.AuditEventWhereInput = {
  OR: FINANCIAL_ACTION_PREFIXES.map((prefix) => ({ action: { startsWith: prefix } })),
};
