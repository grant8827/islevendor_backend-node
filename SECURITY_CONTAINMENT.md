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

### Evidence so far

`test/ledger.test.ts` covers, under concurrency, the parts of these paths that
do not depend on the payment provider: callbacks credit an order exactly once,
escrow is released once and only on a PICKED_UP -> DELIVERED transition,
withdrawals take only released funds, and no balance can go negative.

That is not yet enough to enable any flag in production:

- `ENABLE_WIPAY_WEBHOOKS` — callback verification is still a placeholder and
  does not bind the paid amount, merchant or currency.
- `ENABLE_WITHDRAWALS` — a withdrawal only creates a `REQUESTED` payout; there
  is no approval or disbursement workflow behind it.
- `ENABLE_INTERNAL_REFUNDS` — unchanged; no provider refund is issued.
- `ENABLE_ESCROW_RELEASE` — delivery proof is not yet validated, and the
  driver's fee is still held on the platform account.

## Registration and uploads

- `/api/auth/register` accepts only `CUSTOMER`. Marketplace roles must use
  their controlled onboarding flows; administrator accounts require separate
  audited provisioning tooling.
- New KYC files are written under `private-kyc/` and represented in the database
  by opaque `private-kyc://` references.
- `SERVE_PUBLIC_UPLOADS` defaults to `false`. This also hides legacy public
  product media because the historical directory mixed product and KYC files.
  Do not enable it on an environment containing legacy KYC documents.

### Reviewing KYC documents

Administrators reach documents only through `/api/v1/onboarding`:

- `GET /:type/:id/documents` lists which documents an applicant has on file.
- `POST /:type/:id/documents/:kind/access` returns a link valid for two
  minutes and writes a `kyc_document.access_granted` audit event.
- `DELETE /:type/:id/documents/:kind` removes the file and its reference and
  writes a `kyc_document.deleted` audit event.

Documents uploaded before the split still sit in `uploads/` under a
`/uploads/...` reference. They are reviewable through the same links.
`npm run kyc:migrate-legacy` reports them; with `-- --apply` it moves each
into `private-kyc/`. Run it on the host that holds the upload files. Every
reference it reports was publicly fetchable while `/uploads` was served, so
treat those documents as exposed.

Still required: encrypted private object storage in place of local disk, and
a retention period after which rejected or withdrawn applicants' documents
are deleted.

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
