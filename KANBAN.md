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

### TEST-01 — Add informational coverage reporting

**Epic:** Safety-Critical Test Visibility

**Prompt:**

> Add informational root test coverage reporting and a CI artifact without introducing a blocking percentage threshold. Use the report to identify untested safety-critical branches in authentication, migrations, marketplace error handling, backups, scheduler behavior, refunds, and reconciliation. Add focused tests only where a failure could corrupt data, repeat a deduction/refund, expose information, or broaden a live write.

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

Repository normalization and aggregate reconciliation foundations are complete. Applying the backfill and completing the card require an operator-created operational backup plus reviewed comparisons against the 30-day Etsy and 90-day eBay marketplace dashboards. Resume when those external totals can be reviewed; do not switch the dashboard metric before approval.

## Recently Completed

- Added informational root coverage reports and a non-blocking CI artifact, with initial safety-critical test gaps documented.
- Replaced the decorative Sales map with an offline Natural Earth map, country-volume shading, accessible regional markers, an explicit legend, and visible unknown-geography count.
- Added aggregate-only period reconciliation with separate currencies and categorized integrity warnings.
- Added authoritative eBay refund and Etsy payment-adjustment ingestion with stable identities and unresolved-component safeguards.
- Completed and verified the comparable-sales schema, ADR, normalization foundation, and idempotent refund ledger.
- Added the required development task workflow to `AGENTS.md`.
