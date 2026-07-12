# Josh's Mini ERP Plan

This file contains active and upcoming work only. Completed user-visible work belongs in `CHANGELOG.md`; durable system decisions belong in `docs/ARCHITECTURE.md` or an architecture decision record. `KANBAN.md` contains the executable tickets derived from this plan.

## Direction

- Preserve the working inventory, printing, review, CSV, backup, scheduler, and marketplace workflows.
- Keep SQLite as the normal local database and JSON as a portable backup/export format.
- Keep one canonical local SQLite database for operational modules.
- Keep the local ERP calm, compact, and operational according to `UI_STYLE_GUIDE.md`.
- Keep the embedded Shopify app on Shopify Admin components.
- Keep legacy eBay listings read-only by default. Never enable live quantity writes without an explicitly reviewed safety plan.
- Add an architecture decision record whenever a durable storage, marketplace, deployment, or safety decision changes.

## Current Baseline

- Inventory, printing, reviews, imports, reporting, backups, recovery inspection, scheduling, and marketplace synchronization use the canonical local SQLite database.
- Root checks, informational coverage, Shopify checks, UI smoke coverage, Worker checks, a release checklist, and a dated disposable restore rehearsal are available.
- Production API authentication is enforced; the root ERP remains local-first and is not supported on ephemeral hosting.
- Legacy eBay scanning, local-only mapping, and guarded one-listing migration preview/apply exist. Legacy quantity writes remain disabled.
- Etsy and eBay reviews use official authenticated APIs and shared platform-aware history.
- The Sales ledger normalizes read-only Shopify, eBay, and Etsy orders with coarse geography and no direct customer identifiers.
- Comparable-sales normalization, refunds, source precedence, reconciliation, integrity warnings, verified backfill guards, and desktop/mobile disclosure are implemented. The legacy Revenue headline remains until reviewed historical evidence is approved.
- Credential rotation, recovery, release, marketplace, and deployment procedures are documented in their canonical operator guides.

## Blocked Rollout Work

- [ ] **SALES-03A:** Record matching Etsy Shop Manager and eBay Seller Hub aggregates for exact UTC periods, classify all differences, and create a new dated `APPROVED` or `REJECTED` evidence record.
- [ ] **SALES-03:** After approval, preview and verify the historical financial backfill on a fresh verified backup without switching the dashboard metric.
- [ ] **SALES-04:** After the reviewed backfill and reconciliation pass, switch the dashboard headline and related reporting to currency-separated comparable net sales.
- [ ] **EBAY-NOTIFY-02:** When eBay delivers or rejects the delayed synthetic account-deletion test, verify the returned notification identity is stored idempotently.

These items are blocked on operator dashboard access, explicit backfill approval, or eBay delivery. Their exact unblock conditions are maintained in `KANBAN.md`.

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
- Durable decisions receive an ADR.
- The final review records the commands actually run and any intentionally skipped checks.
