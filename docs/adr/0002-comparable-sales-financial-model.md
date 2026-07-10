# ADR 0002: Comparable Marketplace Sales Financial Model

Date: 2026-07-10

## Context

Marketplace buyer totals are not comparable revenue measures. They may include marketplace-collected tax, buyer-paid shipping, discounts, cancellations, and later refunds. Etsy and eBay also expose different default totals, so summing their buyer totals produces misleading cross-marketplace reporting.

## Decision

- Define comparable net sales as product revenue after seller discounts, plus shipping charged to the buyer, minus refunded pre-tax product and shipping revenue.
- Exclude canceled orders, marketplace-collected tax, and VAT.
- Keep marketplace fees and purchased shipping-label costs separate; they contribute to net-proceeds reporting, not sales revenue.
- Store normalized product, shipping, discount, tax, refund, and comparable-sales components in the canonical SQLite sales ledger.
- Store refunds with stable platform, order, and refund identities so repeated imports are idempotent.
- Record financial source and completeness. Incomplete history remains explicitly incomplete rather than being silently estimated.
- Do not combine currencies without an explicit conversion policy.
- Preserve the existing privacy boundary: financial normalization does not retain additional customer information.

## Source Precedence

1. Official marketplace financial or payment API
2. Official marketplace order API
3. Official transaction report
4. Official order report
5. Legacy approximation

A lower-priority source may fill missing fields but must not overwrite newer authoritative values.

## Consequences

- eBay and Etsy headline sales can be reconciled using the same business definition.
- Buyer-paid international shipping is included even when domestic shipping is free.
- Partial and full refunds can be applied exactly once.
- Historical rows may remain incomplete until an authoritative API or report supplies their breakdown.
- Schema migration and financial backfills require a backup and reconciliation review before the dashboard switches to the new measure.
