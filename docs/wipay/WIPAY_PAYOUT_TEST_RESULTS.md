# Automated WiPay payouts: test results (ISV-WIPAY-001)

**Run:** 14 October 2026, on a local throwaway database (`islevendor_test`, PostgreSQL 17 with PostGIS) and local Redis.
**Command:** `npm test`. Test files run one at a time.
**Result:** **162 tests, 162 passed, 0 failed** across the whole backend.

**No real WiPay request was made.** Every payout test runs against a fake WiPay withdrawal API started inside the test (`test/wipay.payouts.test.ts`). The fake:

- checks the `X-WAPI-Key` header;
- records each request;
- can accept a request, refuse it (400), accept it but lose the response (create, then answer 503), or fail without creating (503);
- serves retrieve and history lookups with statuses the test sets.

The only call to a real WiPay host during this work was a read of the public, unauthenticated sandbox metadata endpoint while auditing.

## What wasn't tested

- **WiPay's real sandbox**, which needs a sandbox WAPI key.
- **The browser screens** (`PayoutDetailsCard`, the admin queue). They pass lint and the production build but haven't been exercised in a browser.
- **`npm run payouts:protect-bank-details -- --apply`.** Only its report mode was run, against the test database: it found 39 plain-text account numbers there.

## Payout, ledger and timing tests (46)

Output of `node --test --test-concurrency=1 test/wipay.payouts.test.ts test/payouts.admin.test.ts test/payout.timing.test.ts test/ledger.test.ts`:

```
    ✔ credits a paid order exactly once, with legs that add up to what was paid
    ✔ splits a shop order between the shop and the platform
    ✔ rejects a callback with a bad signature, or when no key is configured
    ✔ rejects a malformed payload
    ✔ refuses everything while the containment flag is off
    ✔ treats a redelivered callback as a no-op
    ✔ credits once when the same callback arrives many times at the same moment
    ✔ credits once when different transactions for one order arrive at the same moment
    ✔ does not let a transaction id be replayed against a different order
    ✔ leaves a failed payment awaiting retry, and accepts the later success
    ✔ does not credit an order that is no longer awaiting payment
  ✔ WiPay callbacks
    ✔ moves an order from pending to available when the assigned driver delivers it
    ✔ releases once however many times delivery is reported
    ✔ refuses delivery of an order that is not out for delivery
    ✔ refuses delivery by a driver who is not assigned
  ✔ escrow release on delivery
    ✔ cannot withdraw money that is still in escrow
    ✔ withdraws only the delivered portion and leaves the rest in escrow
    ✔ pays out once when several withdrawals are requested at the same moment
    ✔ is refused while the containment flag is off
    ✔ cannot drive a balance negative, even by writing to the database directly
  ✔ withdrawals
✔ ledger integrity
  ✔ counts business days in Jamaica time, skipping weekends
  ✔ is set by an admin, audited, and shown to anyone signed in
  ✔ stamps each withdrawal with the date it should arrive by
✔ payout timing
    ✔ moves the IsleDash fee to the driver's own account on delivery
  ✔ driver earnings
    ✔ shows admins the platform balance and lets them withdraw it, audited
  ✔ IsleVendor's balance
    ✔ lists waiting requests with where to send the money
    ✔ marks a payout paid once, with the transfer reference
    ✔ returns a failed payout's money to the owner, who can withdraw it again
    ✔ is admin-only, and refuses unknown payouts
  ✔ payout queue
✔ payouts
    ✔ stores account and ID numbers encrypted and only ever shows the last four digits
    ✔ needs the current password, a bank WiPay knows, and a valid ID
    ✔ lets manual payouts go ahead without ID details, but not automatic ones
    ✔ rejects tampered ciphertext
  ✔ payout details
    ✔ sends an approved payout to WiPay as a sub_banked withdrawal, and waits for WiPay to complete it
    ✔ never sends a payout twice, even when asked twice at once
    ✔ needs approval first, and is off unless the switch is on
    ✔ returns a refused payout to APPROVED with the reason, to fix and send again
    ✔ returns the money when WiPay sends it back
    ✔ can't be marked paid by hand once it's with WiPay
  ✔ sending
    ✔ finds a submission WiPay accepted but never confirmed, instead of sending it again
    ✔ only releases it to be sent again once WiPay has had time to show it and doesn’t
  ✔ when WiPay doesn’t answer
    ✔ refuses an unsigned, wrongly signed or stale notification
    ✔ confirms with WiPay before applying, and handles each event once
    ✔ records notifications it can’t match
  ✔ notifications
    ✔ refuses WiPay's live payout API until authorisation is confirmed
    ✔ refuses automated payouts with settings missing
  ✔ start-up safeguards
✔ automated WiPay payouts
ℹ tests 46
ℹ pass 46
ℹ fail 0
```

## Problem found and fixed while testing

Running the four files in parallel (without `--test-concurrency=1`) failed two tests. The cause was shared state, not the payout code: the files share platform settings and the platform ledger account. The project's `npm test` already runs files one at a time.

A real test bug also turned up: as the throwaway database accumulated payout requests across runs, the oldest-first queue spilled past one page. The queue test now pages through results.
