# Near-Term Kanban

This board turns the larger epics in `PLAN.md` into small, executable development tasks. Keep it short: when a card is completed, record user-visible results in `CHANGELOG.md`, update the relevant plan checkbox, and remove the card after the next planning pass.

## Board Rules

- Keep at most one card in **Doing** and three cards in **Next**.
- Finish dependencies and verification before pulling the next card.
- Every card must be safe to paste into an AI coding session as its task prompt.
- Do not place credentials, customer data, live listing identifiers, or files under `data/` on this board.
- Back up before migrations or historical marketplace backfills.
- Legacy eBay listing writes remain outside this board unless Josh approves a separate write-safety plan.

## Doing

### SALES-03A — Capture backfill safety and comparison inputs

**Epic:** Comparable Sales Integrity

**Prompt:**

> Prepare the operator evidence needed to unblock SALES-03 without applying a backfill. Create a fresh operational backup with `npm run inv -- backup`, verify its latest manifest with `npm run inv -- restore-dry-run`, and record pre-change SQLite integrity and aggregate table counts with `npm run inv -- db-status`. Refresh the read-only Sales data, then capture aggregate-only reconciliation results for Etsy over 30 days and eBay over 90 days, separated by currency. Manually record the matching sales totals displayed in the Etsy and eBay dashboards for the same date boundaries and business definition. Store only dates, currencies, aggregate amounts, categorized warning counts, and differences in a dated document under `docs/reconciliation/`; do not record credentials, order/listing identifiers, customer data, or files from `data/`. Classify each difference as explained, unresolved, or blocking and explicitly approve or reject proceeding to the SALES-03 apply preview. Do not change inventory, marketplace quantities, or the Sales dashboard metric.

**Acceptance:**

- A new backup manifest passes `restore-dry-run`; its path remains local and is not committed.
- Pre-change SQLite integrity is `ok`, and aggregate sales/refund/transaction row counts are recorded.
- Etsy 30-day and eBay 90-day comparisons use explicit inclusive date boundaries and keep currencies separate.
- The record contains only aggregate financial components, warning counts, marketplace totals, differences, and explanations.
- Every difference is classified as explained, unresolved, or blocking.
- The record ends with an explicit `APPROVED` or `REJECTED` decision for the SALES-03 apply preview and names the remaining unblock condition when rejected.

**Depends on:** Marketplace credentials with read-only sales scopes and operator access to Etsy Shop Manager and eBay Seller Hub dashboards.

## Next

## Later

### SALES-04 — Switch the dashboard to comparable net sales

**Epic:** Comparable Sales Integrity

**Prompt:**

> After reconciliation and backfill approval, switch Sales-page headline revenue, trends, platform mix, geography, and product reporting to comparable net sales. Add a concise “How this is calculated” disclosure, separate fees and shipping-label costs from sales, expose incomplete-history warnings, and retain currency separation. Update focused tests and desktop/mobile UI smoke coverage.

**Depends on:** SALES-03 and reviewed marketplace reconciliation.

### OPS-01 — Perform a disposable restore rehearsal

**Epic:** Recovery Confidence

**Prompt:**

> Create a fresh operational backup and rehearse restoration using only a disposable copy. Verify manifest integrity, SQLite integrity and table counts, print assets, review/sales history, application startup, and read-only reconciliation. Record the date and aggregate verification results without credentials, customer data, or files under `data/`. Correct Operations or Troubleshooting documentation for any gap found.

### RELEASE-01 — Define the first release checklist

**Epic:** Release Readiness

**Prompt:**

> Add a concise release checklist covering a focused clean diff, required checks, dependency audit, changelog, migration and backup review, secret/config validation, deployment boundaries, post-release health checks, read-only reconciliation, rollback, and protected eBay behavior. Keep commands linked to their canonical Operations and Testing documentation instead of duplicating full procedures.

### OPS-02 — Record credential rotation when next performed

**Epic:** Operational Security

**Prompt:**

> During the next real marketplace credential rotation, document the provider-neutral sequence for revocation, replacement, ignored local storage or secret-manager update, connection testing, and reconcile-before-sync. Do not record any credential, token, shop identifier, production URL parameter, or live account detail.

## Blocked

### SALES-03 — Preview and verify historical financial backfill

Repository normalization and aggregate reconciliation foundations are complete. Resume after SALES-03A produces an `APPROVED` evidence record; do not switch the dashboard metric before approval.

## Recently Completed

- Added informational root coverage reports and a non-blocking CI artifact, with initial safety-critical test gaps documented.
- Replaced the decorative Sales map with an offline Natural Earth map, country-volume shading, accessible regional markers, an explicit legend, and visible unknown-geography count.
- Added aggregate-only period reconciliation with separate currencies and categorized integrity warnings.
- Added authoritative eBay refund and Etsy payment-adjustment ingestion with stable identities and unresolved-component safeguards.
- Completed and verified the comparable-sales schema, ADR, normalization foundation, and idempotent refund ledger.
- Added the required development task workflow to `AGENTS.md`.
