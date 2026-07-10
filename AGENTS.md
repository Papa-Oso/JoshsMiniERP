# AI Coding Agent Instructions

Use this file as the first-stop guide for AI-assisted coding in this repo.

## Required Reading

- Read `README.md` for operator setup, commands, credentials, deployment, and data locations.
- Read `PLAN.md` before roadmap, storage, marketplace, sync, backup, or safety work.
- Read `UI_STYLE_GUIDE.md` before changing local ERP screens, CSS, layout, buttons, panels, tables, modals, responsive behavior, workflow copy, or shared UI helpers.

## Product Direction

- Keep the working inventory, printing, sync, review, CSV, backup, and scheduler workflows stable.
- Keep the app local and cheap by default. SQLite is the normal local database at `data/inventory.sqlite`.
- Keep JSON as backup/export/migration format, not the long-term working database.
- Keep Postgres optional for hosted deployment only.
- Keep the embedded Shopify app on Shopify Admin UI components. Do not apply the local ERP visual theme to the Shopify Admin app.

## Safety Rules

- Do not print, copy, commit, or expose `.env`, OAuth tokens, marketplace credentials, database passwords, or files under `data/`.
- Do not install or start Docker, local database services, cloud services, or extra background daemons unless Josh explicitly asks in the current task.
- Do not end, relist, recreate, bulk migrate, bulk revise, or quantity-push legacy eBay listings unless Josh explicitly approves a reviewed write-safety plan.
- For eBay legacy listings, read-only scan and local-only mapping apply are allowed; live quantity writes remain disabled by default.
- `ebay-migrate` preview is allowed; `ebay-migrate --apply` is a live eBay Inventory API migration and must stay one listing at a time with an exact `--confirm-listing-id`.
- Back up before bulk imports, migrations, credential changes, or marketplace mapping changes that affect many SKUs.

## UI Work Rules

- Follow `UI_STYLE_GUIDE.md`.
- Prefer existing design tokens in `src/client/styles.css`.
- Prefer shared helpers in `src/client/ui.tsx` before adding one-off page styling.
- Keep the local ERP calm, compact, operational, and work-focused.
- Avoid decorative glow, neon, heavy gradients, nested cards, and marketing-style landing layouts.
- Check desktop and mobile layout after meaningful UI changes.

## Verification Matrix

- Docs-only changes: run `git diff --check`.
- Server/data behavior changes: run `npm test`, plus focused tests when available.
- Frontend/UI changes: run `npm run build`; run `npm run smoke:ui` after broad layout, shell, page, or visual changes.
- Full pre-commit confidence: run `npm run check`.
- Optional Postgres tests require an existing `TEST_POSTGRES_DATABASE_URL`; do not create a database service just to run them.

## Human Review Checklist

- Did UI work follow `UI_STYLE_GUIDE.md`?
- Did the change preserve SQLite/local-first assumptions?
- Did the change avoid exposing secrets or generated local data?
- Did the change avoid destructive marketplace behavior?
- Did the final response list what verification actually ran?
