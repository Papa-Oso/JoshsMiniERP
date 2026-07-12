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

## Next

## Blocked

### SALES-03A — Capture approved marketplace comparison evidence

The dated readiness record is `REJECTED` because matching Etsy Shop Manager and eBay Seller Hub aggregates were not recorded and remaining refund/reconciliation differences were not fully classified. Resume only with operator dashboard access. Create a new dated evidence file rather than rewriting the historical record; use exact UTC boundaries, currency-separated aggregate values, no customer/order identifiers, and finish with an explicit `APPROVED` or `REJECTED` decision.

### SALES-03 — Preview and verify historical financial backfill

Resume only after SALES-03A produces an `APPROVED` evidence record. Create and inspect a fresh operational backup, keep a preview path, apply no guessed components, compare the result with the approved evidence, and do not switch the dashboard metric as part of this card.

### SALES-04 — Switch the dashboard to comparable net sales

Resume only after SALES-03 completes with reviewed reconciliation results. Then switch headline revenue, trends, marketplace mix, geography, and product reporting to currency-separated comparable net sales; update the existing disclosure, focused tests, and desktop/mobile UI smoke coverage.

### EBAY-NOTIFY-02 — Observe eBay's delayed test delivery

The protected Worker is deployed, paginated, authenticated, and healthy, and the retained signed-notice backlog is processed. Resume only when eBay delivers the accepted synthetic test or exposes a delivery failure. Verify the exact returned notification identity is stored once and that repeated delivery does not increase the namespace count.
