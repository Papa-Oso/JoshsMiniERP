# Deployment

The supported root ERP installation is local-first and uses `data/inventory.sqlite`. A hosted root ERP deployment is intentionally not supported because the current SQLite file requires durable single-machine storage and must not be placed on an ephemeral Cloud Run filesystem.

The embedded Shopify app is a separate deployable surface. Its hosted OAuth session storage may use the database configured by that app's Prisma schema. That session database contains Shopify app sessions; it is not an ERP inventory or reporting database.

## Local ERP

```text
NODE_ENV=
HOST=127.0.0.1
STORE_DRIVER=sqlite
DATABASE_FILE=data/inventory.sqlite
```

Use `npm run dev` for normal operation. Keep `data/`, OAuth tokens, and `.env` out of source control. Run `npm run inv -- backup` before bulk imports, credential changes, or data migrations.

## Embedded Shopify App

The embedded app still requires a stable HTTPS URL, durable session storage, Shopify credentials, and a route to the ERP API. Review the nested Shopify app documentation before deployment. Do not reuse its session database as the ERP database.

Required scopes now include:

```text
read_inventory,write_inventory,read_products,read_locations,read_orders
```

## Recovery

Restore `data/inventory.sqlite` and print assets from an approved operational backup. Start the local ERP, inspect marketplace connections, and run reconcile or dry-run workflows before allowing live inventory writes.
