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

### OPS-02 — Record credential rotation when next performed

**Epic:** Operational Security

**Prompt:**

> During the next real marketplace credential rotation, document the provider-neutral sequence for revocation, replacement, ignored local storage or secret-manager update, connection testing, and reconcile-before-sync. Do not record any credential, token, shop identifier, production URL parameter, or live account detail.

## Blocked

### EBAY-NOTIFY-01 — Verify live deletion-notification delivery

The protected Worker is deployed and eBay endpoint validation succeeds, but the live notification test cannot write while Cloudflare's daily Workers KV put quota is exhausted. Resume immediately after the quota resets or is raised: rerun eBay's delivery test, confirm HTTP success and exactly one stored notice, repeat the same notification-ID test without another write, and review Cloudflare usage. This is the top operational priority and must complete before considering the endpoint fully restored.

### SALES-03 — Preview and verify historical financial backfill

Repository normalization and aggregate reconciliation foundations are complete. Resume after SALES-03A produces an `APPROVED` evidence record; do not switch the dashboard metric before approval.

## Recently Completed

- SALES-EXPLAIN-01 added a compact, responsive calculation disclosure that accurately documents the current legacy Revenue, Orders, Units sold, and Average order headlines without prematurely switching to comparable net sales.
- SALES-VERIFY-01 ensures duplicate refund identities contribute to comparable net sales exactly once while retaining an integrity warning, and covers the exact reporting date boundary.
- RELEASE-01 added a concise release checklist covering scope, changelog, migrations and backup, secrets, full verification and audit, protected eBay behavior, surface-specific deployment checks, read-only reconciliation, and rollback.
- OPS-01 restored a fresh operational backup into an ignored disposable directory, verified manifest and SQLite integrity, operational data groups, captured asset trees, API health, and read-only marketplace reconciliation, and documented the rehearsal procedure and aggregate results.
- EBAY-NOTIFY-02 cryptographically verifies deletion-notification signatures using eBay public keys cached in Worker memory, rejects verification failures before KV, and is deployed with encrypted production application credentials.
- SALES-03C corrected stale persisted comparable-sales values on order refresh, eliminated all 110 Etsy impossible-total warnings, retained two unresolved refund warnings without guessing components, and added focused financial-boundary tests.
- SALES-03B replaced the invalid Etsy payments request with bounded read-only ledger windows, added provider tests, completed two live idempotent refreshes, and restored Etsy financial aggregates.
- SALES-03A created and verified a fresh operational backup, captured aggregate reconciliation evidence, and rejected backfill approval because Etsy payment retrieval and marketplace dashboard comparisons remain blocking. See `docs/reconciliation/2026-07-11-sales-backfill-readiness.md`.
- Added informational root coverage reports and a non-blocking CI artifact, with initial safety-critical test gaps documented.
- Replaced the decorative Sales map with an offline Natural Earth map, country-volume shading, accessible regional markers, an explicit legend, and visible unknown-geography count.
- Added aggregate-only period reconciliation with separate currencies and categorized integrity warnings.
- Added authoritative eBay refund and Etsy payment-adjustment ingestion with stable identities and unresolved-component safeguards.
- Completed and verified the comparable-sales schema, ADR, normalization foundation, and idempotent refund ledger.
- Added the required development task workflow to `AGENTS.md`.
