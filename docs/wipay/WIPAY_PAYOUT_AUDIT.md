# WiPay payout audit (ISV-WIPAY-001)

**Date:** 14 October 2026
**Scope:** `backend-node` and `frontend` on branch `security/p0-authorization`, the Railway WiPay variable names (values not inspected), and WiPay's public developer documentation.
**Method:** Read-only. No WiPay API was called except the public, unauthenticated metadata endpoint `GET https://jmsb.wipayfinancial.com/wapi/withdrawals/meta` (sandbox).

## Summary

The marketplace already had most of the money plumbing: a per-party ledger with escrow, withdrawal requests that can't exceed released funds, an admin payout queue, and an audit log. Three things were missing for automated vendor payouts:

1. Payout details were collected only at sign-up, in plain text, and lacked several fields WiPay requires.
2. There was no step to approve a request separately from paying it.
3. There was no connection to WiPay's withdrawal API.

One correction to the ticket's stated "current payment model": step 2, "WiPay processes customer payments", was **not implemented** at the time of the audit. Checkout created orders awaiting payment but never sent customers to WiPay. The payment confirmation handler existed but was switched off, and its signature check used a placeholder formula. This is outside the payout ticket and is tracked separately.

## What existed before this ticket

| Area | Status | Where |
|---|---|---|
| Earnings ledger | **Complete.** One leg per party per order (warehouse, reseller or shop, platform, driver). Balances are held until delivery, then released to available. Database checks forbid negative balances. | `ledger.service.ts`, `ledger_transactions`, `ledger_accounts` |
| Driver earnings | **Complete.** The IsleDash fee moves from the platform leg to the driver's own account on delivery. | `releaseEscrowForOrder` |
| Withdrawal request | **Complete.** Covers only released, unwithdrawn legs. The account row is locked so two requests can't both take the same money. Each payout is stamped with an expected arrival date. | `withdrawBalance`, `requestPayouts` |
| Admin payout queue | **Partial.** An admin could mark a request paid (with a transfer reference) or failed (money returned). There was no separate approval step. | `admin.routes.ts`, `AdminPayoutsPanel.jsx` |
| Payout destination | **Partial.** Bank name (free text), holder, account number and branch, or a Lynk wallet, captured at sign-up on the business row in plain text. There was no way to change it afterwards. Account type, ID and E.164 phone were missing. | `onboarding.service.ts` |
| Protection of bank data | **Gap.** Account numbers were in plain text. They were masked in the applicant review and shown in full in the payout queue. | — |
| WiPay withdrawal API | **Missing.** | — |
| Payout webhooks | **Missing.** | — |
| Reconciliation with WiPay | **Missing.** | — |
| Audit logging | **Complete** for admin money actions. | `audit_events` |
| Feature flags | **Pattern exists.** `ENABLE_WITHDRAWALS`, `ENABLE_ESCROW_RELEASE` and others. | `env.ts` |

## WiPay variables on Railway compared with what the code read

| Variable | Read by code before | After this ticket |
|---|---|---|
| `WIPAY_ACCOUNT_NUMBER`, `WIPAY_API_KEY` | Yes (payments) | Unchanged |
| `WIPAY_ENV` | Yes, but **only `sandbox` or `production`** | Also accepts WiPay's own value, `live`. A Railway value of `live` would otherwise have stopped the new backend from starting. |
| `WIPAY_COUNTRY_CODE`, `WIPAY_CURRENCY`, `WIPAY_FEE_STRUCTURE`, `WIPAY_ORIGIN`, `WIPAY_PAYMENT_URL`, `WIPAY_RESPONSE_URL` | No | Not yet; reserved for customer checkout |
| `WIPAY_PAYOUT_API_URL`, `WIPAY_PAYOUT_API_KEY`, `WIPAY_PAYOUT_WEBHOOK_SECRET` | No | Read by the payout integration |

## WiPay's documented withdrawal API

Source: [docs.wipayfinancial.com](https://docs.wipayfinancial.com/wapi).

| Endpoint | Purpose |
|---|---|
| `POST {base}/wapi/withdrawals` | Create a withdrawal. Type `sub_banked` pays someone else's bank account. |
| `GET {base}/wapi/withdrawals/{transaction_id}` | Retrieve one withdrawal, including `status` and `fee_amount` |
| `GET {base}/wapi/withdrawals` | History. Filters include amount range, dates, type, `transaction_id` and `reference`; results in `data.data`. |
| `GET {base}/wapi/withdrawals/meta` | Public metadata: banks, ID formats, statuses, types |

Jamaica base URLs: live `https://jm.wipayfinancial.com/wapi`, sandbox `https://jmsb.wipayfinancial.com/wapi`.

### Required `sub_banked` fields for Jamaica

- **Payout:** `currency`, `amount`.
- **Recipient contact:** `email`, `phone` (E.164).
- **Bank:** `bank_name` (from metadata), `bank_account` (digits), `bank_account_type` (`chequing`/`savings`, Jamaica only), `bank_branch` (Jamaica only), `name_in_bank`.
- **Identity:** `id_type` (`driver_permit`, `national_id` or `passport`) and `id_number`.
- **Optional:** `data`, a pass-through string of up to 4,096 characters, echoed back on retrieve, history and webhooks.

### Metadata read live from the sandbox

- **Banks:** National Commercial Bank, Scotiabank Jamaica, JN Bank, JMMB, Sagicor Bank, First Global Bank, CIBC First Caribbean, Citibank. No Lynk.
- **ID formats:**
  - driver's permit: 9 digits;
  - national ID: 7 digits;
  - passport: one letter and 7 digits.
- **Statuses:**

| Code | Meaning |
|---|---|
| 0 | Not on ACH file |
| 1 | Being processed by bank |
| 2 | Transaction completed |
| 3 | Held by compliance |
| 4 | Released by compliance |
| 5 | Refunded to account |
| 6–9 | Chargeback and refund holds |

### Authentication

Protected WAPI routes accept `Authorization: Bearer <token>` or `X-WAPI-Key: <key>`. The withdrawal pages show the bearer form.

### Webhooks

- Events are `withdrawal.*`, sent as a JSON envelope `{id, api_family, event, occurred_at, data, meta}`.
- Signature: `X-WiPay-Webhook-Signature: sha256=<hex>`, the HMAC-SHA256 of `<timestamp>.<raw body>`.
- Timestamp header: `X-WiPay-Webhook-Timestamp`. A 5-minute tolerance is recommended.
- Each event has a stable `id` across retries.

### Not documented, so not assumed

- Whether `sub_banked` is enabled for IsleVendor's account. WAPI Configuration provisioning is mentioned for some features.
- Withdrawal fees, limits and processing times.
- Any idempotency key on create.
- The list of `withdrawal.*` event names.

## Gaps found, and how this ticket closes them

| Gap | Closed by |
|---|---|
| Bank data in plain text | Encrypted `payout_accounts`. New sign-ups are stored encrypted. `npm run payouts:protect-bank-details` migrates existing numbers. |
| Fields WiPay needs | The payout details form collects them. ID details are optional and needed only for automatic payouts. |
| No approval step | `APPROVED` status and an Approve action |
| No WiPay integration | `lib/wipayPayouts.ts` and `submitPayoutToWiPay` / `checkWiPayPayout` |
| No webhook | `POST /api/ledger/webhooks/wipay-payouts` |
| No reconciliation | "Check with WiPay": retrieve by transaction ID, or search history by submission key |
| No switch | `ENABLE_AUTOMATED_PAYOUTS`, plus `WIPAY_PAYOUTS_LIVE_AUTHORIZED` for live |
