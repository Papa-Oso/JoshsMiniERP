# Josh's Mini ERP Plan

This file contains active and upcoming work only. Completed user-visible work belongs in `CHANGELOG.md`; durable system decisions belong in `docs/ARCHITECTURE.md` or an architecture decision record.

## Direction

- Preserve the working inventory, printing, review, CSV, backup, scheduler, and marketplace workflows.
- Keep SQLite as the normal local database and JSON as a portable backup/export format.
- Keep PostgreSQL optional for hosted deployment.
- Keep the local ERP calm, compact, and operational according to `UI_STYLE_GUIDE.md`.
- Keep the embedded Shopify app on Shopify Admin components.
- Keep legacy eBay listings read-only by default. Never enable live quantity writes without an explicitly reviewed safety plan.

## Current Baseline

- Local SQLite storage, JSON portability, and optional Postgres support are implemented.
- Inventory, printing, review, import, reconcile, sync, backup, restore dry-run, reporting, and scheduler workflows are implemented.
- Root build and tests, Shopify typecheck, UI smoke coverage, and Worker smoke coverage exist.
- Production API token enforcement and documented Cloud Run deployment exist.
- Legacy eBay scan, local-only mapping, and guarded one-listing migration preview/apply exist. Legacy quantity writes remain disabled.

## Active Work: Repository Maintainability

Goal: make the project easier to understand, safer to change, and independently verifiable.

### Documentation

- [x] Separate development, architecture, operations, marketplace, deployment, testing, and troubleshooting guidance.
- [x] Keep the root README focused on orientation and quick start.
- [x] Remove live operational state and real listing identifiers from examples.
- [x] Add contribution, security, license, and changelog files.
- [ ] Add architecture decision records when a new durable decision is made.

### Automated Quality

- [x] Add root linting and formatting checks.
- [x] Add focused Worker and UI check commands.
- [x] Add a comprehensive local `check:all` command.
- [x] Add pull-request CI without live marketplace credentials.
- [ ] Add test coverage reporting as an informational signal, then identify safety-critical gaps.

### Operations

- [ ] Perform and record a dated restore rehearsal using a non-production copy.
- [ ] Add a credential-rotation runbook after the next marketplace credential rotation.
- [ ] Define a small release checklist once the first tagged release is prepared.

## Protected eBay Work

Allowed without further approval:

- Read-only listing scans
- Migration previews
- Local-only exact-match mapping previews and applies
- Reconcile and dry-run sync review

Requires an explicit reviewed plan:

- Live legacy listing quantity writes
- Bulk migration or revision
- Ending, relisting, deleting, or recreating listings
- Any change capable of losing listing history, watchers, ranking, or sales history

Any live migration must remain one listing at a time and require an exact `--confirm-listing-id` after backup and preview.

## Definition of Done

A change is complete only when:

- Its behavior and safety boundaries are documented where an operator or developer will find them.
- Relevant focused tests pass.
- `npm run check` passes for code changes.
- Broad UI changes also pass `npm run check:ui` and receive desktop/mobile review.
- Worker changes pass `npm run check:worker`.
- The final review records the commands actually run and any intentionally skipped checks.
