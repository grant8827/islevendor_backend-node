import crypto from 'node:crypto';
import { env } from '../env.js';
import { redis } from './redis.js';

// Long enough for a label printed at packing time to still scan when the
// driver turns up later the same day or the next morning.
export const PICKUP_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// Derived rather than JWT_SECRET itself, so a pickup token can never be
// replayed as (or forged from) a login token and vice versa.
const signingKey = crypto.createHmac('sha256', env.JWT_SECRET).update('islevendor:pickup-token:v1').digest();

function currentTokenKey(orderId: string): string {
  return `pickup_token:${orderId}`;
}

function sign(orderId: string, expiresAt: number, nonce: string): string {
  return crypto.createHmac('sha256', signingKey).update(`${orderId}.${expiresAt}.${nonce}`).digest('base64url');
}

/**
 * Mints the token a shipping label's QR code carries (see dispatch.routes.ts's
 * POST /orders/:id/pickup-token). Knowing the order id alone no longer lets a
 * driver claim the package — they need this, i.e. the physical label.
 *
 * Only the most recently issued token for an order is live: its nonce is
 * what Redis holds, so reprinting a label invalidates the previous one.
 */
export async function issuePickupToken(orderId: string): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = Math.floor(Date.now() / 1000) + PICKUP_TOKEN_TTL_SECONDS;
  const nonce = crypto.randomBytes(12).toString('base64url');
  await redis.set(currentTokenKey(orderId), nonce, 'EX', PICKUP_TOKEN_TTL_SECONDS);
  return { token: `${expiresAt}.${nonce}.${sign(orderId, expiresAt, nonce)}`, expiresAt: new Date(expiresAt * 1000) };
}

/** The nonce if `token` is authentic, unexpired and still the live one for `orderId`; otherwise null. */
export async function verifyPickupToken(orderId: string, token: unknown): Promise<string | null> {
  if (typeof token !== 'string') return null;
  const [expiresAtRaw, nonce, signature, ...rest] = token.split('.');
  if (!expiresAtRaw || !nonce || !signature || rest.length > 0) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= Date.now()) return null;

  const expected = Buffer.from(sign(orderId, expiresAt, nonce));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;

  return (await redis.get(currentTokenKey(orderId))) === nonce ? nonce : null;
}

/**
 * Burns the token after a successful claim so it can't be scanned again.
 * Compare-and-delete in one step: a label reprinted in the same instant
 * keeps its fresh nonce rather than having it deleted out from under it.
 */
export async function consumePickupToken(orderId: string, nonce: string): Promise<void> {
  await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    1,
    currentTokenKey(orderId),
    nonce,
  );
}
