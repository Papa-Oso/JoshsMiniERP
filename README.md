# Josh's Mini ERP

Local-first inventory, printing, review, and marketplace synchronization for a personal Etsy, eBay, and Shopify operation.

The normal application runs on one computer with SQLite at `data/inventory.sqlite`. It does not require Docker, a database service, or a cloud account. JSON is reserved for backups, exports, and migrations; PostgreSQL is optional for hosted deployment.

## Quick Start

Requires Node `>=20.19 <22` or `>=22.12`.

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
| [Operations](docs/OPERATIONS.md)           | Daily commands, backup, restore, scheduler, and CSV workflows |
| [Marketplaces](docs/MARKETPLACES.md)       | Shopify, Etsy, eBay, OAuth, mapping, and write-safety rules   |
| [Deployment](docs/DEPLOYMENT.md)           | Cloud Run, Cloud SQL, secrets, and production checks          |
| [Testing](docs/TESTING.md)                 | Test layers, required checks, and live-service boundaries     |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common startup, storage, credential, and sync problems        |
| [UI style guide](UI_STYLE_GUIDE.md)        | Local ERP visual and interaction standards                    |
| [Plan](PLAN.md)                            | Active priorities and acceptance criteria                     |

AI coding agents must also follow [AGENTS.md](AGENTS.md).

## Quality Checks

```powershell
npm run check
npm run check:worker
npm run check:ui
npm run check:all
npm run audit:all
```

Optional PostgreSQL tests require an existing `TEST_POSTGRES_DATABASE_URL`. Do not create a local database service solely to run them.

## Data Locations

- `data/inventory.sqlite`: normal local inventory and operational history
- `data/inventory.json`: portable migration/export format
- `data/printing/`: uploaded print assets
- `data/feedback.sqlite`: local eBay feedback history
- `data/backups/`: operational backups

The entire `data/` directory is local-only and ignored by Git.
