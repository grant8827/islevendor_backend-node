# Automated WiPay payouts: security review (ISV-WIPAY-001)

A self-review of the changes against the ticket's security requirements. It is not an independent review; that remains on the release checklist.

## Requirements

| Requirement | How it's met | Evidence |
|---|---|---|
| Don't expose API keys | Keys are read from environment variables only and never returned by any endpoint or logged. The WAPI key is sent only to `WIPAY_PAYOUT_API_URL` as `X-WAPI-Key`. | `env.ts`, `wipayPayouts.ts` |
| Protect banking information | Account and ID numbers are AES-256-GCM encrypted with a random 96-bit IV and an auth tag, using `PAYOUT_DATA_KEY`. Owners and the audit log see only the last four digits. Full numbers are decrypted only for an admin's payout queue and for the WiPay request. | `crypto.ts`, `payoutAccounts.ts`; test "stores account and ID numbers encrypted…" |
| Tampering detected | GCM authentication rejects altered ciphertext. | Test "rejects tampered ciphertext" |
| No withdrawal beyond settled funds | Only `AVAILABLE` legs (released on delivery) can be requested. The debit is conditional on the balance, and database CHECK constraints forbid negative balances. | `requestPayouts`; ledger tests |
| Transactions and locking | Withdrawals lock the ledger account row. Approval, submission claim, settlement and status changes are conditional updates. Fund returns run in the same transaction as the status change. | `ledger.service.ts` |
| Idempotent payouts | One submission per approval: the `APPROVED → SUBMITTED` claim is conditional and committed before the call. `submissionKey` is unique. Concurrent sends produce one WiPay request. | Test "never sends a payout twice, even when asked twice at once" |
| Idempotent webhooks | WiPay's event `id` is unique in `payout_webhook_events`. A redelivery does nothing. | Test "confirms with WiPay before applying, and handles each event once" |
| Never retry an uncertain payout unverified | A timeout or 5xx leaves the payout `SUBMITTED` and blocks resending. Only "Check with WiPay" can release it, and only after a history search finds nothing **and** 15 minutes have passed. | Tests under "when WiPay doesn't answer" |
| Accepted is not completed | A 201 moves the payout to `PROCESSING`. `PAID` requires WiPay status `2`, read from WiPay's API. | Test "…waits for WiPay to complete it" |
| Webhook authenticity | HMAC-SHA256 over `timestamp.rawBody` with constant-time comparison. Missing, malformed, wrongly signed or stale (>5 minutes) requests are rejected. The payload's status is never applied directly; WiPay's API is asked. | Test "refuses an unsigned, wrongly signed or stale notification" |
| No live automated payouts before authorisation | Start-up refuses the live WiPay host unless `WIPAY_PAYOUTS_LIVE_AUTHORIZED=true`, and refuses it entirely outside `NODE_ENV=production`. `ENABLE_AUTOMATED_PAYOUTS` defaults to `false`. | Tests under "start-up safeguards" |
| Changing payout destination | Requires the current password and is audited. A destination change after approval doesn't alter what was approved: the masked snapshot is kept, and submission re-checks completeness. | `payoutAccount.routes.ts` |
| Admin-only actions | Every `/api/admin` route re-checks that the caller is currently an admin (not just the token's role). Every money action is audited. | `requireCurrentAdmin`, admin tests |

## Residual risks and follow-ups

1. **Plain-text legacy bank numbers.** They remain on business rows until `npm run payouts:protect-bank-details -- --apply` is run with `PAYOUT_DATA_KEY` set. After that, drop the columns.
2. **Key management.** `PAYOUT_DATA_KEY` sits in Railway's environment alongside the database credentials, so someone with both can read the numbers. A managed KMS would separate them. There is no key rotation yet; the `v1:` prefix leaves room for it.
3. **Full numbers in the admin payout queue.** These are needed for manual transfers. Viewing the queue isn't individually audited. Consider masking until an admin clicks "reveal", with an audit entry.
4. **Password-only confirmation for changing payout details.** Two-factor or an email confirmation to the old address would better resist account takeover. Session revocation exists for suspected compromise.
5. **ID numbers** are collected only for automatic payouts. Confirm the privacy notice covers them, and set a retention period.
6. **WAPI authentication.** If WiPay requires bearer tokens instead of `X-WAPI-Key` for withdrawals, tokens must be fetched and cached securely. This is not built.
7. **No scheduled reconciliation.** A payout whose webhook never arrives stays `PROCESSING` until an admin clicks "Check with WiPay".
8. **No rate limiting** on the webhook or the payout details endpoints yet. The broader login and abuse hardening ticket covers this.
