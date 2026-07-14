# Development

## Prerequisites

- Node `>=20.19 <22` for the root ERP, or Node `>=22.18` for the complete ERP and embedded Shopify app toolchain
- npm
- PowerShell for the documented Windows commands

No Docker, local database service, cloud service, or background daemon is required for normal development.

## Setup

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

The UI runs at `http://127.0.0.1:5175`; the API runs at `http://127.0.0.1:5174`. Keep `NODE_ENV` unset locally.

For normal Windows use, double-click `Start ERP.cmd` in the repository root. The
launcher runs `npm run dev`, waits for the UI, and opens it in the default
browser. If the app is already available, it opens the existing instance instead
of starting a duplicate. Keep the launcher terminal open and press `Ctrl+C` to
stop the local servers.

The Shopify app has its own dependency tree:

```powershell
Set-Location shopify-app/joshs-mini-erp
npm ci
npm run setup
```

`npm run setup` initializes the Shopify session database. It does not initialize the root ERP inventory database.

## Project Layout

```text
src/client/                         Local React ERP
src/server/                         API, CLI, stores, sync, and marketplace adapters
src/shared/                         Shared application types
tests/                              Root behavioral and store tests
scripts/                            Local deployment and UI smoke helpers
shopify-app/joshs-mini-erp/         Embedded Shopify Admin app
workers/ebay-account-deletion/      eBay compliance Worker
data/                               Ignored local operational data
```

## Change Workflow

Follow the required Directions → Split → Augment → Execute → QA → Test → Commit → Push → Merge sequence in `AGENTS.md`. Use `KANBAN.md` for the current executable queue and `PLAN.md` for larger product epics.

Do not combine a visual redesign with inventory, printing, or sync behavior changes unless the behavior change is required to fix the same issue.

## Scripts

| Command                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Start local API and Vite UI                      |
| `npm run build`        | Root typecheck and client production build       |
| `npm test`             | Root Node test suite                             |
| `npm run lint`         | Root TypeScript/React lint                       |
| `npm run format:check` | Check formatting without changing files          |
| `npm run check`        | Required deterministic code checks               |
| `npm run check:ui`     | Browser smoke checks against a running local app |
| `npm run check:worker` | eBay Worker smoke test                           |
| `npm run check:all`    | Full local confidence suite                      |
| `npm run audit:all`    | Audit both npm dependency trees                  |

See `docs/TESTING.md` for check selection and external-service boundaries.

## Environment

Copy `.env.example` to `.env` and fill only the integrations being used. `.env` and `data/` are ignored by Git. Never paste their contents into issues, commits, logs, or AI conversations.

SQLite is the default:

```env
STORE_DRIVER=sqlite
DATABASE_FILE=data/inventory.sqlite
```

Use `STORE_DRIVER=json` only as a compatibility bridge. SQLite is the only supported working database for the root ERP.
