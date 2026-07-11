# Release Checklist

Use this checklist before the first tag and every later release. A release may cover the local ERP, embedded Shopify app, Cloudflare compliance Worker, or more than one surface; deploy and verify only the surfaces changed.

## Prepare

- [ ] Confirm the branch is current, the worktree is clean, and the diff contains only the intended release scope.
- [ ] Review `CHANGELOG.md` and ensure completed user-visible changes, migrations, operational changes, and known limitations are accurate.
- [ ] Review schema or storage changes against [Architecture](ARCHITECTURE.md) and [Data Model](DATA_MODEL.md). Create and inspect a fresh operational backup before any migration or bulk backfill, following [Operations](OPERATIONS.md).
- [ ] Confirm no `.env`, files under `data/`, credentials, tokens, logs, browser state, or generated local artifacts are tracked or staged.
- [ ] Review configuration by variable name only. Confirm local ERP, Shopify app, and Worker secrets remain in their documented secret stores; never print values for release review.

## Verify

- [ ] Run the release-confidence checks and dependency audits from [Testing](TESTING.md): `npm run check:all` and `npm run audit:all`.
- [ ] Resolve task-related failures. Record pre-existing or externally blocked failures precisely; do not silently waive a required check.
- [ ] Recheck marketplace write boundaries in [Marketplaces](MARKETPLACES.md). A release must not enable legacy eBay quantity writes, bulk revision, relisting, or migration without its separately approved safety plan.

## Publish

- [ ] Create a focused release commit and push it without force-pushing.
- [ ] Confirm the reviewed local commit matches the remote commit and required repository checks pass.
- [ ] Tag only the reviewed commit. Use an annotated version tag and push that tag after the commit is available remotely.
- [ ] Deploy only changed hosted surfaces according to [Deployment](DEPLOYMENT.md). The root ERP remains local-first and is not deployed to ephemeral hosting.

## Confirm

- [ ] Start the affected surface and perform its documented health check.
- [ ] For the local ERP, inspect database health and run read-only reconciliation or sync dry-run before allowing live synchronization. Follow [Operations](OPERATIONS.md).
- [ ] For the Shopify app, confirm embedded-app loading and session-backed access without exposing session data.
- [ ] For the account-deletion Worker, confirm endpoint validation and a verified, idempotent notification delivery without using synthetic traffic to consume KV unnecessarily.
- [ ] Confirm scheduled jobs and marketplace write settings retain their pre-release safety state.

## Roll Back

- [ ] If health or integrity checks fail, stop the affected deployment or automation before attempting data repair or marketplace synchronization.
- [ ] Roll code back to the last known-good tag or deployment version without force-pushing shared history.
- [ ] Restore operational data only from an inspected manifest-backed backup using the recovery procedure in [Operations](OPERATIONS.md); reconcile read-only before any live sync.
- [ ] Record the failure, rollback, data impact, and remaining follow-up without including credentials or customer data.
