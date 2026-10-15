import { Router, type Request } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../env.js';
import { handlePaymentsWebhook, handleWiPayReturn, paymentForCustomer, retryPayment } from './payments.service.js';

export const paymentsRouter = Router();
export const wipayWebhookRouter = Router();

/** This API's own public origin, for building the WiPay return address when WIPAY_RESPONSE_URL isn't set. */
export const requestOrigin = (req: Request) => `${req.protocol}://${req.get('host')}`;

/** The marketplace's payment status page for a payment. */
function statusPage(paymentId: string | null) {
  const web = (env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN.split(',')[0]).replace(/\/$/, '');
  return paymentId ? `${web}/payment/${paymentId}` : `${web}/account?tab=orders`;
}

// The customer's payment status page reads from here — never from the
// browser's own idea of how WiPay went.
paymentsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    res.json(await paymentForCustomer(String(req.params.id), req.user!.sub));
  } catch (err) {
    next(err);
  }
});

// Try paying again (a declined card, a closed tab): a new WiPay checkout for
// whatever in this payment is still unpaid.
paymentsRouter.post('/:id/retry', requireAuth, async (req, res, next) => {
  try {
    const payment = await retryPayment(String(req.params.id), req.user!.sub, requestOrigin(req));
    res.status(201).json({ id: payment.id, status: payment.status, checkoutUrl: payment.checkoutUrl, message: payment.message });
  } catch (err) {
    next(err);
  }
});

// WIPAY_RESPONSE_URL. GET: WiPay sending the customer back after paying —
// verified, applied, then the customer is sent to their status page.
wipayWebhookRouter.get('/', async (req, res, next) => {
  try {
    const payment = await handleWiPayReturn(req.query);
    res.redirect(303, statusPage(payment?.id ?? null));
  } catch (err) {
    next(err);
  }
});

// POST: WiPay's Payments API webhook, if one is registered (payment.* events).
wipayWebhookRouter.post('/', async (req, res, next) => {
  try {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    res.json(await handlePaymentsWebhook(rawBody ?? Buffer.alloc(0), req.headers));
  } catch (err) {
    next(err);
  }
});
