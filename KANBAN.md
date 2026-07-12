# Near-Term Kanban

This board turns the larger epics in `PLAN.md` into small, executable development tasks. Keep it short: when a card is completed, record user-visible results in `CHANGELOG.md`, update the relevant plan checkbox, and remove the card after the next planning pass.

## Board Rules

- Keep at most one card in **Doing** and three cards in **Next**.
- Finish dependencies and verification before pulling the next card.
- Whenever a card is completed or removed, count the unblocked cards in **Doing** and **Next**. If fewer than two remain, review every unchecked item in `PLAN.md` and add one or two of the highest-priority items that are actionable without external approval, credentials, live marketplace writes, quota recovery, or production data.
- Turn plan items into small, independently testable tickets with a clear prompt, dependencies, and safety boundaries. Do not copy an epic-sized checkbox into the board when it should be split.
- If no unfinished plan item is currently actionable, record that conclusion under **Blocked** with the exact dependency instead of leaving the executable queue silently empty.
- Every card must be safe to paste into an AI coding session as its task prompt.
- Do not place credentials, customer data, live listing identifiers, or files under `data/` on this board.
- Back up before migrations or historical marketplace backfills.
- Legacy eBay listing writes remain outside this board unless Josh approves a separate write-safety plan.

## Doing

### SALES-06 — Audit canonical comparable-sales invariants

**Epic:** Comparable Sales Integrity

**Prompt:**

> Audit the canonical comparable-sales calculation against the six unchecked measure requirements in `PLAN.md`: canceled-order exclusion, tax/VAT exclusion, buyer-paid shipping inclusion, exactly-once refunds, separate fees and shipping-label costs, and currency separation. Close any repository behavior or focused-test gaps without switching the Sales dashboard headline or running a historical backfill. Check off only requirements proven by implementation and tests, and document any remaining external-data dependency as a smaller follow-up.

**Depends on:** Normalized financial model and reconciliation service. SALES-03 and SALES-04 remain out of scope.

## Next

### SALES-07 — Audit financial backfill safety gates

**Epic:** Comparable Sales Integrity

**Prompt:**

> Audit repository commands and documentation that can perform schema migration or bulk financial backfill. Ensure every apply path requires or creates a verified backup before mutation, keeps a dry-run or preview path, and marks incomplete historical financial rows instead of inventing component values. Add focused tests for any missing repository guard. Do not run a real backfill, inspect production data, or change marketplace state. Check off the corresponding `PLAN.md` requirement only when every repository-controlled path is proven safe; document external operational steps separately.

**Depends on:** Existing backup, migration, and financial import workflows. No live credentials or production data are required.

### SALES-08 — Add dashboard calculation explanation and warnings

**Epic:** Comparable Sales Integrity

**Prompt:**

> Add a concise dashboard disclosure describing how comparable net sales is calculated and why canceled orders, tax/VAT, buyer-paid shipping, refunds, separate fees, shipping-label costs, and currency separation are handled the way they are. Surface incomplete-history or reconciliation warning text on the Sales page without switching the headline metric. Add focused tests for the new disclosure and warning behavior.

**Depends on:** Existing Sales dashboard flow and reconciliation service. No headline metric switch is required.

## Later

### SALES-04 — Switch the dashboard to comparable net sales

**Epic:** Comparable Sales Integrity

**Prompt:**

> After reconciliation and backfill approval, switch Sales-page headline revenue, trends, platform mix, geography, and product reporting to comparable net sales. Add a concise “How this is calculated” disclosure, separate fees and shipping-label costs from sales, expose incomplete-history warnings, and retain currency separation. Update focused tests and desktop/mobile UI smoke coverage.

**Depends on:** SALES-03 and reviewed marketplace reconciliation.

### OPS-02 — Record credential rotation when next performed

**Epic:** Operational Security

**Prompt:**

> During the next real marketplace credential rotation, document the provider-neutral sequence for revocation, replacement, ignored local storage or secret-manager update, connection testing, and reconcile-before-sync. Do not record any credential, token, shop identifier, production URL parameter, or live account detail.

## Blocked

### EBAY-NOTIFY-02 — Observe eBay's delayed test delivery

The protected Worker is deployed, paginated, authenticated, and healthy; all 1,365 retained signed notices are processed. eBay's official subscription test API accepted repeated requests with HTTP 202 and returned notification IDs, but no test delivery appeared during the observation window. Resume when eBay delivers a queued test or exposes a delivery failure, then verify the exact returned notification ID is stored once and repeated delivery does not increase the namespace count.

### SALES-03 — Preview and verify historical financial backfill

Repository normalization and aggregate reconciliation foundations are complete. Resume after SALES-03A produces an `APPROVED` evidence record; do not switch the dashboard metric before approval.

## Recently Completed

- **EBAY-NOTIFY-01:** Restored the live deletion-notification feed with 25-record cursor pages, processed a 521-notice backlog after backup, verified zero pending notices across 55 live pages, confirmed unauthorized feed access returns 401, and confirmed the enabled eBay subscription targets the deployed Worker. Production delivery is proven by 1,365 unique signed notices; delayed synthetic-test observation remains tracked separately.
