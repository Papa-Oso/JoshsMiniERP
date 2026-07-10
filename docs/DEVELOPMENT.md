# Development

## Prerequisites

- Node `>=20.19 <22` or `>=22.12`
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

1. Read `AGENTS.md` and the task-specific documentation.
2. Check `git status` and preserve unrelated work.
3. Make the smallest change that solves the problem.
4. Add or update focused tests.
5. Run the checks appropriate to the change.
6. Review the diff for secrets, local data, generated artifacts, and accidental marketplace writes.

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

Use `STORE_DRIVER=json` only as a compatibility bridge. Use Postgres only for an intentional hosted deployment with an existing database.
