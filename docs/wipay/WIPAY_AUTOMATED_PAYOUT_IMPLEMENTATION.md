# Automated WiPay payouts: implementation (ISV-WIPAY-001)

Automated payouts are **optional and off by default**. Manual payouts work exactly as before, with one new step in front: approval.

## Payout lifecycle

```
REQUESTED ──Approve──► APPROVED ──Paid by hand──► PAID      (channel MANUAL)
    │                     │      ──Failed──────► FAILED     (money returned)
    │                     │
    │                     └──Send via WiPay──► SUBMITTED ──WiPay 201──► PROCESSING ──WiPay status 2──► PAID
    │                                              │                        └────────WiPay status 5──► FAILED (money returned)
    │                                              ├──WiPay 4xx──► back to APPROVED (with WiPay's reason)
    │                                              └──timeout / 5xx──► stays SUBMITTED until "Check with WiPay"
    └──Paid by hand / Failed (as before)
```

| Status | Meaning |
|---|---|
| `REQUESTED` | Created by the owner's Withdraw. The money has already left their available balance. |
| `APPROVED` | An admin has checked the request. Records `approvedAt`, `approvedBy` and a masked `destinationSnapshot`. |
| `SUBMITTED` | We are asking WiPay, or asked and never heard back. Committed **before** the HTTP call, with a fresh `submissionKey`, so two clicks can't both send. |
| `PROCESSING` | WiPay created the withdrawal. **This is not paid.** |
| `PAID` | Manual: an admin recorded a transfer reference. WiPay: WiPay's own status is `2` (transaction completed). Nothing else marks a WiPay payout paid. |
| `FAILED` | The legs are freed and the available balance restored, so the owner can withdraw again. |

WiPay status mapping, in `interpretStatus`:

| WiPay status | Payout result |
|---|---|
| `2` | PAID |
| `5` (refunded to account) | FAILED |
| everything else | PROCESSING |

Codes 6–9 are left for a person to look at. Their `status_description` is shown in the queue.

## Never sending twice

- **Concurrent clicks:** the `APPROVED → SUBMITTED` update is conditional and committed before WiPay is called. Only one request wins.
- **Our own reference on every submission:** `submissionKey` (a UUID, unique) goes into WiPay's `data` field as `{"payoutId","submissionKey"}`.
- **WiPay refuses (4xx):** nothing was created. The payout goes back to `APPROVED` with WiPay's message in `lastError`, and can be fixed and sent again.
- **No answer (timeout, connection error, 5xx):** the payout stays `SUBMITTED` and can't be sent again. "Check with WiPay" searches WiPay's withdrawal history (same amount, `sub_banked`, since the submission date) for the submission key:
  - **Found:** it was accepted. We record WiPay's transaction ID and move to `PROCESSING`.
  - **Not found, within 15 minutes of submission:** we refuse to conclude anything. "Check again in a few minutes."
  - **Not found, after 15 minutes:** it was never accepted. The payout goes back to `APPROVED` with a new key next time.
- **Manual settlement is blocked** for `SUBMITTED` and `PROCESSING`: "Paid by hand" and "Failed" are refused once a payout is with WiPay.

## Webhook

`POST /api/ledger/webhooks/wipay-payouts`. Register this address in WiPay's Developer dashboard for the WAPI (withdrawals) family. The signing secret goes in `WIPAY_PAYOUT_WEBHOOK_SECRET`.

1. **Verify the signature:** `sha256=` plus the hex HMAC-SHA256 of `"<X-WiPay-Webhook-Timestamp>.<raw body>"`, compared in constant time. Reject anything outside a 5-minute window. The raw bytes are captured by `express.json({ verify })` in `app.ts`.
2. **Skip duplicates:** if the event `id` is already in `payout_webhook_events`, answer `{ duplicate: true }`.
3. **Find the payout** by `data.transaction_id`, or by `payoutId` in the pass-through `data`.
4. **Ask WiPay for the withdrawal** (`GET /withdrawals/{id}`) and apply **WiPay's record**. The status in the webhook payload is not trusted on its own.
5. **Record the event** (outcome `applied`, `already_settled`, `unmatched` or `ignored`) and answer 2xx. Any failure answers non-2xx, so WiPay retries.

## Payout details

A `payout_accounts` table holds one record per user. Owners manage it from the "Payout details" card on their Payouts tab, through `GET`/`PUT /api/ledger/payout-account` and `GET /api/ledger/payout-options`.

- **Bank fields:**
  - bank (one of WiPay's 8 Jamaican banks, by WiPay's name);
  - branch;
  - chequing or savings;
  - account number (5–20 digits, **encrypted**, last four kept readable);
  - name on the account.

  Or a Lynk wallet instead.
- **Fields for automatic payouts** (optional):
  - ID type and number (**encrypted**, validated against WiPay's formats);
  - email;
  - phone, normalised to E.164 (`+1876…`).
- **Safeguards:**
  - Saving requires the current password.
  - Every change is audited as `payout_account.updated`. The record says what changed, never the numbers.
- **"Ready for automatic payout"** means a bank account with every field WiPay needs. Lynk wallets are always paid by hand, because WiPay pays bank accounts only.
- **New sign-ups:** once `PAYOUT_DATA_KEY` is set, bank numbers are written encrypted to `payout_accounts`, and the business row keeps only `••••1234`.
- **Existing sign-ups:**
  - `npm run payouts:protect-bank-details` reports what it would change;
  - `-- --apply` moves the numbers into encrypted storage and masks the plain-text copy;
  - safe to re-run.

## Admin

| Endpoint | Action | Audit event |
|---|---|---|
| `POST /api/admin/payouts/:id/approve` | `REQUESTED → APPROVED` | `payout.approved` |
| `POST /api/admin/payouts/:id/send-wipay` | Send through WiPay. Needs the switch on and complete details. | `payout.wipay_submission_started`, `payout.sent_to_wipay` |
| `POST /api/admin/payouts/:id/check-wipay` | Reconcile with WiPay | `payout.checked_with_wipay` |
| `PATCH /api/admin/payouts/:id` | Paid by hand / Failed, from `REQUESTED` or `APPROVED` | `payout.paid`, `payout.failed` |
| `GET /api/admin/payouts?status=` | Every status. Each row shows the destination (decrypted for the admin, marked "from sign-up" if not yet confirmed), whether it's ready for WiPay, and WiPay's transaction, status, fee and last error. | — |

## Configuration

| Variable | Purpose |
|---|---|
| `PAYOUT_DATA_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). **Required** to save payout details. Keep it secret and backed up: losing it makes stored numbers unreadable. |
| `ENABLE_AUTOMATED_PAYOUTS` | `false` by default. When `true`, start-up requires `WIPAY_PAYOUT_API_URL`, `WIPAY_PAYOUT_API_KEY`, `WIPAY_PAYOUT_WEBHOOK_SECRET` and `PAYOUT_DATA_KEY`. |
| `WIPAY_PAYOUT_API_URL` | The WAPI base, e.g. `https://jmsb.wipayfinancial.com/wapi` |
| `WIPAY_PAYOUT_API_KEY` | Sent as `X-WAPI-Key` |
| `WIPAY_PAYOUT_WEBHOOK_SECRET` | The webhook signing secret |
| `WIPAY_PAYOUTS_LIVE_AUTHORIZED` | Must be `true` before the live host (`jm.wipayfinancial.com`) is allowed. Set it **only after WiPay confirms `sub_banked` is authorised for IsleVendor.** The live host is also refused outside `NODE_ENV=production`. |

## Files

- **Backend:**
  - `prisma/migrations/20261014200000_payout_accounts_and_wipay/`
  - `src/lib/crypto.ts`, `src/lib/payoutAccounts.ts`, `src/lib/wipayBanks.ts`, `src/lib/wipayPayouts.ts`
  - `src/modules/ledger/ledger.service.ts` (approval, submission, check, status, webhook)
  - `src/modules/ledger/payoutAccount.routes.ts`, `src/modules/ledger/ledger.routes.ts`, `src/modules/admin/admin.routes.ts`
  - `src/modules/onboarding/onboarding.service.ts`, `src/app.ts`, `src/env.ts`
  - `prisma/protectBankDetails.ts`
  - `test/wipay.payouts.test.ts`
- **Frontend:**
  - `components/dashboard/PayoutDetailsCard.jsx`, `PayoutsPanel.jsx`, `PayoutHistoryPanel.jsx`
  - `pages/admin/AdminPayoutsPanel.jsx`, `AuditLogPanel.jsx`

## Jira tasks

### Completed

1. Audit the existing payment and withdrawal implementation
2. Review WiPay integrations and environment variables, and fix the `WIPAY_ENV=live` start-up failure
3. Identify database models and payout logic
4. Verify the documented WiPay withdrawal endpoints, statuses, banks and ID formats
5. Vendor payout details management (bank, branch, type, account, name, ID, email, phone)
6. Encrypt account and ID numbers at rest; require a password to change payout details; mask everywhere except the admin payout view
7. Earnings ledger (already complete: escrow, driver share, non-negative checks)
8. Prevent duplicate withdrawals and duplicate submissions
9. Admin withdrawal approval step
10. WiPay `sub_banked` payout integration behind a switch
11. Signed, de-duplicated payout webhook that confirms with WiPay
12. Reconciliation ("Check with WiPay") and audit logging of every payout action
13. Manual payouts preserved
14. Feature flags `ENABLE_AUTOMATED_PAYOUTS` and `WIPAY_PAYOUTS_LIVE_AUTHORIZED`
15. Automated tests against a fake WiPay server (17 new; 162 in the suite)
16. Documentation (these four files)

### Outstanding

1. **WiPay confirmations (below).** Then a sandbox run against real WiPay with a sandbox WAPI key.
2. **Production rollout steps:** set `PAYOUT_DATA_KEY` on Railway, run the migration, run `payouts:protect-bank-details -- --apply`, register the payout webhook in WiPay.
3. **Remove the plain-text bank columns** from `warehouses`, `reseller_stores`, `shops` and `driver_profiles` once every row is protected.
4. **WiPay's payout fee.** Decide whether it's deducted from the payout or absorbed by IsleVendor. It's recorded (`providerFeeJmd`) but not yet charged to anyone.
5. **Scheduled reconciliation:** check every `SUBMITTED`/`PROCESSING` payout periodically instead of only on demand or by webhook.
6. **Notify owners** (email or in-app) when a payout is paid or fails.
7. **Payout details on the mobile apps**, which have no Payouts screen.
8. **Customer checkout through WiPay** (a separate ticket). Customers can't pay yet.

## WiPay approvals and missing credentials

1. **`sub_banked` withdrawals:** written confirmation that they're authorised (WAPI Configuration) for IsleVendor's Jamaica business account, in **sandbox and live**.
2. **A sandbox WAPI key** (`wapi_test_…`) for testing against WiPay's sandbox.
3. **The `X-WAPI-Key` header:** confirmation that `WIPAY_PAYOUT_API_KEY` is a WAPI key accepted for `POST /withdrawals` with that header. If withdrawals need an OAuth bearer token instead, the client must obtain one.
4. **The withdrawal webhook:** registration for `https://<backend>/api/ledger/webhooks/wipay-payouts`, with the signing secret in `WIPAY_PAYOUT_WEBHOOK_SECRET`.
5. **Fees, limits and timing:** the per-payout fee, any limits, and typical time to the recipient's bank, so the advertised payout time matches.
6. **Event names and statuses:** the `withdrawal.*` event names, and the meaning of statuses 6–9 for outgoing withdrawals.
7. **Retry safety:** whether repeated `POST /withdrawals` calls are idempotent on any field. The integration doesn't rely on it; it reconciles by `data` instead.
8. **Lynk:** whether WiPay can pay Lynk wallets. Today those payouts stay manual.
