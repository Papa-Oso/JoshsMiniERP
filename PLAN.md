# Josh's Mini ERP Plan

This file contains active and upcoming work only. Completed user-visible work belongs in `CHANGELOG.md`; durable system decisions belong in `docs/ARCHITECTURE.md` or an architecture decision record.

## Direction

- Preserve the working inventory, printing, review, CSV, backup, scheduler, and marketplace workflows.
- Keep SQLite as the normal local database and JSON as a portable backup/export format.
- Keep one canonical local SQLite database for operational modules.
- Keep the local ERP calm, compact, and operational according to `UI_STYLE_GUIDE.md`.
- Keep the embedded Shopify app on Shopify Admin components.
- Keep legacy eBay listings read-only by default. Never enable live quantity writes without an explicitly reviewed safety plan.

## Current Baseline

- Local SQLite storage and JSON portability are implemented.
- Inventory, printing, review, import, reconcile, sync, backup, restore dry-run, reporting, and scheduler workflows are implemented.
- Root build and tests, Shopify typecheck, UI smoke coverage, and Worker smoke coverage exist.
- Production API token enforcement and documented Cloud Run deployment exist.
- Legacy eBay scan, local-only mapping, and guarded one-listing migration preview/apply exist. Legacy quantity writes remain disabled.
- Etsy reviews import through the official paginated API into the shared platform-aware review history, including review photos and Review Center concerns.
- eBay reviews use the official authenticated Feedback API with incremental pagination and image URL capture; browser scraping has been removed from the supported path.
- A local sales ledger and Sales dashboard normalize read-only Shopify, eBay, and Etsy orders for revenue, product, platform, trend, and coarse geographic reporting.

## Upcoming Repository Follow-ups

- [ ] Add an architecture decision record whenever a new durable storage, marketplace, deployment, or safety decision is made.
- [x] Add informational test coverage reporting, then identify safety-critical gaps.
- [x] Perform and record a dated restore rehearsal using a non-production copy.
- [ ] Add a credential-rotation runbook after the next marketplace credential rotation.
- [x] Define a small release checklist before the first tagged release.

## Active Work: Comparable Sales Integrity and Geographic Reporting

Goal: make marketplace sales totals explainable, auditable, and comparable across eBay and Etsy while preserving the local-only privacy boundary.

### Canonical Sales Measure

The primary dashboard measure is comparable net sales:

```text
product revenue after seller discounts
+ shipping charged to the buyer
- refunded pre-tax product and shipping revenue
= comparable net sales
```

- [x] Exclude canceled orders entirely.
- [x] Exclude marketplace-collected sales tax and VAT.
- [x] Include buyer-paid shipping, including dynamic eBay and fixed Etsy international shipping.
- [x] Apply full and partial refunds exactly once.
- [x] Keep marketplace fees and purchased shipping labels separate from sales; use them only in expense and net-proceeds reporting.
- [x] Group totals by currency until a reviewed exchange-rate policy exists; never silently combine currencies.

### Normalized Financial Model

- [x] Add order-level product, shipping, discount, tax, refund, and comparable-sales amounts to the canonical SQLite sales ledger.
- [x] Add normalized, idempotent refund records keyed by platform, order, and refund identity.
- [x] Record financial completeness, source, source update time, and reconciliation state without retaining additional customer information.
- [x] Preserve existing gross and subtotal values during migration for audit and rollback comparison.
- [x] Document the durable financial model in `docs/DATA_MODEL.md` and an ADR before switching the headline metric.

### Marketplace Ingestion

- [x] Extend eBay order imports to retain price subtotal, delivery cost and discounts, product discounts, tax, cancellation state, and API refunds.
- [x] Reconcile eBay order API values with imported financial transactions for fees, refunds, shipping labels, and net proceeds.
- [x] Extend Etsy receipt imports to retain subtotal, shipping cost, discounts, tax, VAT, paid/canceled state, and payment/refund details.
- [x] Use source precedence: official financial/payment API, official order API, transaction report, order report, then legacy approximation.
- [x] Allow lower-priority sources to fill missing fields without overwriting newer authoritative values.

### Reconciliation and Integrity

- [x] Report imported, included, canceled, refunded, and unresolved order counts for each platform and period.
- [x] Reconcile buyer charges into product, shipping, discounts, tax, refunds, comparable net sales, fees, labels, and net proceeds.
- [x] Warn on duplicate refunds, unmatched refunds, mixed currencies, missing financial breakdowns, impossible totals, stale pulls, and API/report disagreement.
- [x] Add a dashboard calculation explanation so operators can reproduce each headline value.
- [x] Back up before schema migration or bulk financial backfill; mark incomplete historical rows instead of guessing.

### Useful Geographic Map

- [x] Replace the hand-drawn world polygons with a locally bundled Natural Earth country map rendered as responsive SVG.
- [x] Keep the map offline and local-first; do not add live tile services, geocoding, or API keys.
- [x] Shade countries by order volume and overlay approximate regional centroid markers where country/region data supports them.
- [x] Provide keyboard-accessible tooltips with region, country, orders, units, and comparable net sales.
- [x] Show an unknown-geography count, a clear size/color legend, and a ranked country list. No reset is needed because the map does not zoom.
- [x] Retain only country and region geography; never store or plot customer street, city, postal, or exact coordinates.

### Verification and Rollout

- [x] Cover domestic free shipping, international paid shipping, discounts, cancellations, full and partial refunds, refunded shipping/tax, duplicate imports, mixed currencies, and date boundaries.
- [x] Assert that tax never contributes to comparable sales, canceled orders contribute zero, and refunds are applied exactly once.
- [ ] Backfill on a verified backup, compare new results against marketplace dashboards, and review unresolved differences before switching the headline metric.
- [ ] Run `npm test`, `npm run build`, `npm run lint`, and `npm run check:ui`; inspect Sales at desktop and mobile widths.

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
