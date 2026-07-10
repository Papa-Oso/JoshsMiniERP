# Testing

## Required Checks

| Change                    | Minimum verification                                         |
| ------------------------- | ------------------------------------------------------------ |
| Documentation only        | `npm run format:check` and `git diff --check`                |
| Root server/data behavior | `npm test` plus focused tests                                |
| Root frontend             | `npm run build`; add `npm run check:ui` for broad UI changes |
| Shopify app               | `npm run shopify:typecheck` and `npm run shopify:lint`       |
| Account-deletion Worker   | `npm run check:worker`                                       |
| Normal code change        | `npm run check`                                              |
| Release confidence        | `npm run check:all` and `npm run audit:all`                  |

## Test Boundaries

The normal suite uses temporary files, temporary SQLite databases, and fake marketplace adapters. It must not contact live Etsy, eBay, Shopify, Cloudflare, Cloud SQL, or other external services.

UI smoke tests expect the local app to be running at `http://127.0.0.1:5175` unless `UI_SMOKE_URL` is set. Screenshots are written under ignored `data/ui-smoke/`.

## Safety-Critical Coverage

Changes to these areas should include focused regression tests:

- Sync baseline, sale deduction, and failed push behavior
- Marketplace mapping identity changes
- Legacy eBay scan, mapping, and migration guards
- CSV and marketplace imports
- Backup, export, and restore dry-run behavior
- Path validation for uploaded and printed assets
- Production API authentication
- SQLite migrations and store contract behavior

Coverage percentages should be treated as a discovery tool, not a substitute for scenario-based safety tests.

## Manual Review

Broad UI changes still require desktop and mobile review for overflow, keyboard focus, dialog dismissal, disabled state clarity, and non-color status cues. Live marketplace operations require the preview and backup sequence in `docs/OPERATIONS.md` even when automated tests pass.
