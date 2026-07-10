# ADR 0001: Local Marketplace Sales Ledger

Date: 2026-07-10

## Context

Inventory quantity changes can indicate that units sold, but they do not provide reliable order revenue, order dates, product lines, marketplace attribution, refunds, or destination geography. A cross-marketplace Sales page needs normalized order data from Shopify, eBay, and Etsy.

## Decision

- Pull orders read-only from each marketplace's official API.
- Store normalized orders and line items in the canonical local SQLite database at `data/inventory.sqlite`.
- Key orders by marketplace plus the marketplace's stable order ID so refreshes are idempotent.
- Retain only coarse destination geography (`country_code` and `region_code`). Do not retain customer names, emails, phone numbers, street addresses, cities, or postal codes.
- Treat marketplace values as reported. Do not silently convert currencies; warn when a view contains more than one currency.
- Keep sales reporting separate from inventory sale detection. Importing sales must never adjust inventory or marketplace quantities.
- Use the shared SQLite coordinator so modules cannot overwrite one another's transactions.
- Include sales tables in the normal operational database backup.

## Consequences

- The Sales page can show revenue, order and unit counts, trends, products, marketplace mix, and a world map without expanding the application's PII footprint.
- Marketplace history is limited by each API and granted scopes. Shopify normally exposes 60 days unless all-orders access is approved; eBay and Etsy enforce their own retention and authorization rules.
- Former separate `data/sales.sqlite` and `data/feedback.sqlite` files are migrated once into the canonical database and retained as timestamped migration archives.
