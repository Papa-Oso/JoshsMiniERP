# Credential Rotation

Use this runbook for planned rotation or suspected exposure of marketplace, ERP API, Shopify app, or Worker credentials. Rotate one integration at a time so failures stay attributable and normal inventory workflows remain recoverable.

Do not perform a live rotation merely to test this document. Never record secret values, OAuth codes, token-file contents, authorization headers, shop/account identifiers, or protected production URL parameters.

## Prepare

1. Identify the affected integration, credential owner, storage location category, dependent surfaces, and revocation deadline using variable names only.
2. Create and inspect a fresh operational backup with the commands in [Operations](OPERATIONS.md).
3. Record current health and run read-only reconciliation or sync dry-run where the integration supports it.
4. Confirm a rollback credential can remain valid until the replacement passes verification, unless suspected compromise requires immediate revocation.
5. Pause scheduled or live write workflows for the affected integration.

## Rotate

1. Create or authorize the replacement through the provider's official console or OAuth flow.
2. Store it only in its approved location:
   - ignored root `.env` or an ignored token file under `data/` for the local ERP;
   - the hosted secret manager and durable session storage for the embedded Shopify app;
   - encrypted Worker secrets for the eBay account-deletion Worker.
3. Restart or redeploy only the affected surface. Do not copy a local ERP secret into browser code, source control, an image, documentation, or a command transcript.
4. Run the smallest read-only connection check first. For OAuth, confirm the required scopes without printing the token or session.
5. Run reconcile or the relevant dry-run workflow before re-enabling any live inventory synchronization.
6. Revoke the prior credential after the replacement passes, or immediately when required by an exposure response.

## Verify

- The affected health or connection check succeeds.
- Read-only marketplace data can be retrieved with expected scopes.
- Reconciliation or dry-run results are understood before live writes resume.
- Scheduled jobs and marketplace write settings match their pre-rotation safety state.
- The old credential is revoked and no longer accepted when provider tooling can verify that safely.
- `git status` shows no credential, token file, `.env`, log, or file under `data/` staged or tracked.

## Record

Record only the date, integration, reason category, storage location category, verification commands, aggregate outcome, old-credential revocation status, and any non-secret follow-up. Keep provider account identifiers and production URLs out of the repository record.

## Failure and Rollback

Keep scheduled and live writes paused. Restore the previous still-valid secret only when it was not exposed and provider policy allows rollback. Otherwise, create another replacement through the official flow. Re-run the read-only check and reconciliation before resuming writes; restoring the operational database does not restore or revoke provider credentials.
