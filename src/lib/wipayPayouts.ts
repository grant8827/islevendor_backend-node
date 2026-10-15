import { env } from '../env.js';

// WiPay's withdrawal API (WAPI), used to pay a seller's or driver's bank
// account automatically. Documented at
// https://docs.wipayfinancial.com/wapi/withdrawals/createWithdrawal — this
// is a thin client; the payout rules live in ledger.service.ts.
//
// Only "sub_banked" withdrawals are sent: money from IsleVendor's WiPay
// balance to someone else's Jamaican bank account. That needs WiPay to have
// authorised the account — nothing here assumes it has.

export interface SubBankedWithdrawal {
  amountJmd: string;
  email: string;
  phone: string;
  bankName: string;
  bankAccount: string;
  bankAccountType: 'chequing' | 'savings';
  bankBranch: string;
  nameInBank: string;
  idType: 'driver_permit' | 'national_id' | 'passport';
  idNumber: string;
  /** Pass-through data WiPay echoes back on retrieve, history and webhooks. */
  data: string;
}

export interface WiPayWithdrawal {
  transaction_id: string;
  reference?: string;
  status?: number;
  status_description?: string;
  fee_amount?: string;
  amount?: string;
  data?: string;
}

/** WiPay's withdrawal status codes (GET /withdrawals/meta), and what each means for a payout. */
export const WIPAY_WITHDRAWAL_STATUS = {
  NOT_ON_ACH_FILE: 0,
  BEING_PROCESSED_BY_BANK: 1,
  TRANSACTION_COMPLETED: 2,
  HELD_BY_COMPLIANCE: 3,
  RELEASED_BY_COMPLIANCE: 4,
  REFUNDED_TO_ACCOUNT: 5,
} as const;

/** What a status code means for the payout: finished paying, finished failing, or still going. */
export function interpretStatus(status: number | undefined): 'PAID' | 'FAILED' | 'IN_PROGRESS' {
  if (status === WIPAY_WITHDRAWAL_STATUS.TRANSACTION_COMPLETED) return 'PAID';
  // The money came back to IsleVendor's WiPay balance: the transfer didn't happen.
  if (status === WIPAY_WITHDRAWAL_STATUS.REFUNDED_TO_ACCOUNT) return 'FAILED';
  // 0, 1, 3, 4 are normal stages; 6–9 (chargeback/refund holds) are left for
  // a person to look at rather than guessed at.
  return 'IN_PROGRESS';
}

/** Thrown when we can't know whether WiPay accepted a request — a timeout, a dropped connection, a 5xx. */
export class WiPayUncertainError extends Error {}

/** Thrown when WiPay definitely refused a request (4xx). Nothing was created. */
export class WiPayRejectedError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!env.WIPAY_PAYOUT_API_URL || !env.WIPAY_PAYOUT_API_KEY) throw new Error('WiPay payouts are not configured');
  let res: Response;
  try {
    res = await fetch(`${env.WIPAY_PAYOUT_API_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'X-WAPI-Key': env.WIPAY_PAYOUT_API_KEY, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new WiPayUncertainError(`No response from WiPay: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: { message?: string; data?: unknown } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON — handled by the status checks below.
  }
  if (res.status >= 500) throw new WiPayUncertainError(`WiPay returned ${res.status}`);
  if (!res.ok) throw new WiPayRejectedError(json.message ?? `WiPay returned ${res.status}`, res.status);
  return json.data as T;
}

export function createSubBankedWithdrawal(w: SubBankedWithdrawal) {
  return call<WiPayWithdrawal>('POST', '/withdrawals', {
    withdrawal_type: 'sub_banked',
    currency: 'JMD',
    amount: Number(w.amountJmd),
    email: w.email,
    phone: w.phone,
    bank_name: w.bankName,
    bank_account: w.bankAccount,
    bank_account_type: w.bankAccountType,
    bank_branch: w.bankBranch,
    name_in_bank: w.nameInBank,
    id_type: w.idType,
    id_number: w.idNumber,
    data: w.data,
  });
}

export function retrieveWithdrawal(transactionId: string) {
  return call<WiPayWithdrawal>('GET', `/withdrawals/${encodeURIComponent(transactionId)}`);
}

/**
 * IsleVendor's sub_banked withdrawals for one amount since a date — narrowed
 * that far so the one we're looking for is on the first page. Used to find a
 * submission whose outcome we never heard (GET /withdrawals; the list is at
 * data.data, with pagination beside it).
 */
export async function findWithdrawals(filter: { amountJmd: string; since: Date }): Promise<WiPayWithdrawal[]> {
  const params = new URLSearchParams({
    page_size: '100',
    amount_min: filter.amountJmd,
    amount_max: filter.amountJmd,
    start_date: filter.since.toISOString().slice(0, 10),
    'withdrawal_type[]': 'sub_banked',
  });
  const page = await call<{ data?: WiPayWithdrawal[] }>('GET', `/withdrawals?${params}`);
  return page?.data ?? [];
}
