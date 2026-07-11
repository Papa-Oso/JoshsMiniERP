# Sales Backfill Readiness — 2026-07-11

## Decision

**REJECTED** — do not run the SALES-03 apply preview yet.

Unblock when the Etsy payment/refund refresh uses a supported read-only API request, both marketplace refreshes complete successfully, and matching Etsy Shop Manager and eBay Seller Hub aggregate totals are recorded for the exact periods below.

## Safety evidence

- Evidence generated: `2026-07-11T02:38:41Z`
- Fresh operational backup: created locally and not committed
- Backup manifest verification: `RESTORABLE`
- Pre-change SQLite integrity: `ok`
- Orders before refresh: 3,381
- Line items before refresh: 3,400
- Orders after refresh: 3,385
- Line items after refresh: 3,404
- Saved refunds after refresh: 16
- Saved eBay financial transactions after refresh: 5,170
- Inventory or marketplace quantity writes: none

The repeat-safe eBay refresh found four previously unseen orders. No duplicate order identities were created.

## Etsy comparison

Period: trailing 30 days ending `2026-07-11T02:38:41Z` (cutoff `2026-06-11T02:38:41Z`). Currency: USD.

| Component            | ERP aggregate |
| -------------------- | ------------: |
| Imported orders      |           110 |
| Included orders      |           108 |
| Canceled orders      |             2 |
| Unresolved orders    |           108 |
| Product revenue      |         $0.00 |
| Shipping revenue     |         $0.00 |
| Refunds applied      |         $0.00 |
| Comparable net sales |         $0.00 |

Warnings: 110 missing financial breakdowns. The read-only Etsy refresh failed with a required payment-query parameter error, so the zero financial components are incomplete and must not be compared or approved.

Etsy Shop Manager total: not recorded because the ERP side is not yet comparable.

Classification: **blocking**.

## eBay comparison

Period: trailing 90 days ending `2026-07-11T02:38:41Z` (cutoff `2026-04-12T02:38:41Z`). Currency: USD.

| Component            | ERP aggregate |
| -------------------- | ------------: |
| Imported orders      |           380 |
| Included orders      |           374 |
| Canceled orders      |             6 |
| Refunded orders      |            16 |
| Unresolved orders    |           374 |
| Product revenue      |    $10,409.36 |
| Shipping revenue     |         $9.99 |
| Discounts            |       $272.20 |
| Refunds applied      |         $0.00 |
| Comparable net sales |    $10,419.35 |
| Fees                 |     $1,523.08 |
| Shipping labels      |        $42.50 |
| Net proceeds         |     $7,265.42 |

Warnings: 16 unresolved refunds, 380 missing financial breakdowns, and five API/report disagreements. Refunds without provable product/shipping/tax components remain excluded rather than guessed.

eBay Seller Hub total: not yet recorded.

Classification: **blocking** until the matching dashboard aggregate is recorded and the unresolved differences are reviewed.

## Follow-up

1. Replace the unsupported Etsy shop payments collection request with a supported read-only payment retrieval flow and add focused tests.
2. Rerun the Etsy 30-day and eBay 90-day reconciliation with exact UTC boundaries.
3. Record matching marketplace dashboard aggregates and classify every difference.
4. Approve SALES-03 only when no unexplained blocking difference remains.
