# Historical Application Audit — 2026-07-10

This file is a compact archive of the completed repository audit. It is not a current architecture guide, risk register, roadmap, or task source.

Use the canonical documents instead:

- [Development](DEVELOPMENT.md) for setup, scripts, and change workflow
- [Architecture](ARCHITECTURE.md) and [Data Model](DATA_MODEL.md) for durable system decisions
- [Operations](OPERATIONS.md), [Credential Rotation](CREDENTIAL_ROTATION.md), and [Marketplaces](MARKETPLACES.md) for operator safety
- [Testing](TESTING.md) and [Releases](RELEASES.md) for verification
- [Plan](../PLAN.md) and [Kanban](../KANBAN.md) for all unfinished work
- [Changelog](../CHANGELOG.md) for completed user-visible results

## Audit Scope

The 2026-07-10 audit reviewed documentation, architecture, developer workflow, testing, security, marketplace safety, deployment boundaries, and repository hygiene.

## Durable Findings

- SQLite is the single supported root ERP working database; JSON is a portability format.
- The local ERP owns inventory. Marketplace values are observations and reviewed synchronization targets.
- Read-only reconciliation, dry-run workflows, stable identities, and guarded eBay legacy behavior are essential safety boundaries.
- The root ERP, embedded Shopify app, and eBay account-deletion Worker are separate deployment and storage concerns.
- Secret values and files under `data/` must remain outside source control and documentation.

## Completed Outcomes

The audit and its follow-up work produced the current documentation map, governance files, lint and formatting checks, CI, informational coverage, focused safety tests, UI and Worker smoke checks, the release checklist, the disposable restore rehearsal, and clearer deployment and marketplace boundaries.

The original audit roadmap and pending-risk prose were pruned after completion because active work is maintained only in `PLAN.md` and `KANBAN.md`. Full historical wording remains available in Git history.
