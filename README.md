# Josh's Mini ERP

Local-first inventory, printing, review, sales, and marketplace synchronization for a personal Etsy, eBay, and Shopify operation.

The application runs on one computer with SQLite at `data/inventory.sqlite`. It does not require Docker, a database service, or a cloud account. JSON is reserved for backups, exports, and migrations.

## Quick Start

Requires Node `>=20.19 <22` for the root ERP, or Node `>=22.18` for the complete ERP and embedded Shopify app toolchain.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Open `http://127.0.0.1:5175`. The API listens on `http://127.0.0.1:5174`.

Leave `NODE_ENV` unset for local use. Production startup requires `ERP_API_TOKEN`.

## Daily Safety Rules

- Add and subtract inventory through this application so the event history remains accurate.
- Run `npm run inv -- backup` before bulk imports, migrations, credential changes, or marketplace mapping changes.
- Preview imports and marketplace changes before applying them.
- Reconcile before running a live sync.
- Treat legacy eBay listings as protected assets. Read-only scans and local mapping are allowed; live quantity writes remain disabled by default.
- Never commit `.env`, OAuth tokens, database credentials, or anything under `data/`.

See [Operations](docs/OPERATIONS.md) for the complete safe workflow and recovery guidance.

## Common Commands

```powershell
npm run dev                  # Local UI and API
npm run inv -- doctor       # Non-destructive health check
npm run inv -- db-status    # SQLite integrity and table counts
npm run inv -- backup       # Operational backup
npm run inv -- list         # List inventory
npm run inv -- reconcile shopify
npm run inv -- sync --dry-run --platform shopify
npm run check               # Build, tests, lint, and Shopify typecheck
```

The complete CLI and marketplace setup references are in [Operations](docs/OPERATIONS.md) and [Marketplaces](docs/MARKETPLACES.md).

## Documentation

| Document                                   | Purpose                                                       |
| ------------------------------------------ | ------------------------------------------------------------- |
| [Development](docs/DEVELOPMENT.md)         | Setup, scripts, project layout, and change workflow           |
| [Architecture](docs/ARCHITECTURE.md)       | Data ownership, storage, sync behavior, and system boundaries |
| [Data model](docs/DATA_MODEL.md)           | Canonical SQLite tables, identities, practices, and queries   |
| [Operations](docs/OPERATIONS.md)           | Daily commands, backup, restore, scheduler, and CSV workflows |
| [Marketplaces](docs/MARKETPLACES.md)       | Shopify, Etsy, eBay, OAuth, mapping, and write-safety rules   |
| [Deployment](docs/DEPLOYMENT.md)           | Local ERP and embedded-app deployment boundaries              |
| [Testing](docs/TESTING.md)                 | Test layers, required checks, and live-service boundaries     |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common startup, storage, credential, and sync problems        |
| [UI style guide](UI_STYLE_GUIDE.md)        | Local ERP visual and interaction standards                    |
| [Plan](PLAN.md)                            | Active priorities and acceptance criteria                     |
| [Near-term kanban](KANBAN.md)              | Current executable work queue derived from the plan           |

AI coding agents must also follow [AGENTS.md](AGENTS.md).

## Quality Checks

```powershell
npm run check
npm run check:worker
npm run check:ui
npm run check:all
npm run audit:all
```

## Data Locations

- `data/inventory.sqlite`: normal local inventory and operational history
- `data/inventory.json`: portable migration/export format
- `data/printing/`: uploaded print assets
- Review and sales tables live in `data/inventory.sqlite` alongside inventory and operational history.
- `data/backups/`: operational backups

The entire `data/` directory is local-only and ignored by Git.
