# Security containment controls

These controls are deliberately fail-closed. They are temporary release
barriers, not substitutes for completing the corresponding security and
financial-integrity work.

## Database isolation

- Development and test processes accept local Postgres hosts by default.
- A remote non-production database requires both an isolated environment and
  `ALLOW_REMOTE_DATABASE=true`.
- Non-production processes reject `DATABASE_ENVIRONMENT=production`.
- Production processes require `DATABASE_ENVIRONMENT=production`.
- `WIPAY_ENV=production` is rejected outside `NODE_ENV=production`.

Never use `ALLOW_REMOTE_DATABASE` to bypass isolation and connect a developer
workstation or CI job to production.

## Disabled money operations

The following flags default to `false`:

- `ENABLE_WIPAY_WEBHOOKS`
- `ENABLE_WITHDRAWALS`
- `ENABLE_INTERNAL_REFUNDS`
- `ENABLE_ESCROW_RELEASE`

Do not enable a flag until its provider verification, authorization,
idempotency/concurrency behavior, reconciliation behavior, and rollback path
have automated test evidence and an approved deployment plan. Enabling WiPay
webhooks also requires both WiPay credentials at startup. A missing verification
key always rejects callbacks.

## Registration and uploads

- `/api/auth/register` accepts only `CUSTOMER`. Marketplace roles must use
  their controlled onboarding flows; administrator accounts require separate
  audited provisioning tooling.
- New KYC files are written under `private-kyc/` and represented in the database
  by opaque `private-kyc://` references.
- `SERVE_PUBLIC_UPLOADS` defaults to `false`. This also hides legacy public
  product media because the historical directory mixed product and KYC files.
  Do not enable it on an environment containing legacy KYC documents.

An authorized private-document retrieval endpoint and object storage are still
required before administrators can review new KYC documents in production.

## Deployment and rollback

1. Deploy with every containment flag set to `false` explicitly.
2. Verify startup logs contain no unsafe-environment error.
3. Confirm withdrawal, refund, and webhook requests receive HTTP 503.
4. Confirm `/uploads/<legacy-file>` is not publicly reachable.
5. Roll back by redeploying the previous application artifact. Do not work
   around a failed startup guard; correct the environment classification or
   database target instead.

Before any later flag enablement, take a database backup, record the approver,
deployment artifact, enablement time, verification evidence, and disablement
procedure in the incident/change record.
