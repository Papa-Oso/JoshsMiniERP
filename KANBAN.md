# Near-Term Kanban

This board contains only current executable tickets and exact external blockers derived from `PLAN.md`. Completed results belong in `CHANGELOG.md`, not on this board.

## Board Rules

- Keep at most one card in **Doing** and three cards in **Next**.
- Finish dependencies and verification before pulling the next card.
- Turn plan items into small, independently testable tickets with a clear prompt, dependencies, and safety boundaries.
- Every card must be safe to paste into an AI coding session as its task prompt.
- Do not place credentials, customer data, live listing identifiers, or files under `data/` on this board.
- Do not run live marketplace writes, historical backfills, credential rotations, or production-data operations unless the card and Josh explicitly authorize them.
- When Doing and Next are empty, review every active plan item. Record exact external dependencies under **Blocked** instead of creating placeholder queue cards.

## Doing

### DB-01 — Cover partial-schema migration recovery

**Epic:** Safety-Critical Test Hardening

**Prompt:**

> Add focused tests for opening legacy and partially upgraded SQLite schemas, including a forced migration failure after the verified pre-migration copy is created. Prove that the working test database remains recoverable, existing rows are preserved, incomplete financial fields stay explicitly incomplete, and retrying the supported migration is idempotent. Use disposable databases only; do not inspect or copy `data/inventory.sqlite`.

**Depends on:** Existing SQLite store, migration backup guards, and temporary-database tests.

## Next

### MKT-01 — Cover malformed and partial marketplace imports

**Epic:** Safety-Critical Test Hardening

**Prompt:**

> Add focused fake-adapter tests for marketplace timeouts, malformed success bodies, pagination failure after an earlier page, and incomplete order/refund batches. Assert that failed pulls are reported as failures, atomic imports do not persist partial financial history, prior saved orders remain intact, and no inventory or marketplace quantity mutation occurs. Cover the shared guarantees with the smallest representative Etsy, eBay, and Shopify cases; do not contact live services.

**Depends on:** Existing importer fakes, atomic sales import, and pull-failure recording.

### OPS-03 — Cover backup and scheduler failure reporting

**Epic:** Safety-Critical Test Hardening

**Prompt:**

> Add focused tests for operational backup copy failure, invalid or incomplete manifests, automatic-prune refusal, and Windows scheduler installation command failure. Assert that partial backups are never reported as verified or restorable, retained good backups are not removed, scheduler settings are not reported as installed after command failure, and error messages identify the failed stage without exposing environment values. Use temporary paths and mocked process execution only.

**Depends on:** Existing backup inspection/prune tests and scheduler preview/install boundaries. Do not install a real scheduled task.

## Blocked

### SALES-03A — Capture approved marketplace comparison evidence

The dated readiness record is `REJECTED` because matching Etsy Shop Manager and eBay Seller Hub aggregates were not recorded and remaining refund/reconciliation differences were not fully classified. Resume only with operator dashboard access. Create a new dated evidence file rather than rewriting the historical record; use exact UTC boundaries, currency-separated aggregate values, no customer/order identifiers, and finish with an explicit `APPROVED` or `REJECTED` decision.

### SALES-03 — Preview and verify historical financial backfill

Resume only after SALES-03A produces an `APPROVED` evidence record. Create and inspect a fresh operational backup, keep a preview path, apply no guessed components, compare the result with the approved evidence, and do not switch the dashboard metric as part of this card.

### SALES-04 — Switch the dashboard to comparable net sales

Resume only after SALES-03 completes with reviewed reconciliation results. Then switch headline revenue, trends, marketplace mix, geography, and product reporting to currency-separated comparable net sales; update the existing disclosure, focused tests, and desktop/mobile UI smoke coverage.

### EBAY-NOTIFY-02 — Observe eBay's delayed test delivery

The protected Worker is deployed, paginated, authenticated, and healthy, and the retained signed-notice backlog is processed. Resume only when eBay delivers the accepted synthetic test or exposes a delivery failure. Verify the exact returned notification identity is stored once and that repeated delivery does not increase the namespace count.
