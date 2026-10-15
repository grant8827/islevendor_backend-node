import crypto from 'node:crypto';
import { env } from '../env.js';
import { HttpError } from '../middleware/errorHandler.js';

// Field-level encryption for sensitive values kept in the database — bank
// account numbers and ID numbers on payout accounts. AES-256-GCM with a
// random IV per value; the stored form is "v1:<iv>:<tag>:<ciphertext>", all
// base64. The key (PAYOUT_DATA_KEY) lives only in the environment, so a
// database dump alone doesn't reveal the numbers.

const VERSION = 'v1';

function key(): Buffer {
  if (!env.PAYOUT_DATA_KEY) {
    throw new HttpError(503, 'Payout details can’t be saved right now — encryption isn’t configured');
  }
  return Buffer.from(env.PAYOUT_DATA_KEY, 'base64');
}

export function encryptField(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptField(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** "••••1234". */
export const maskLast4 = (last4: string | null | undefined) => (last4 ? `••••${last4}` : null);
