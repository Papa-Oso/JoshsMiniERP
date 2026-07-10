# AI Coding Agent Instructions

Use this file as the first-stop guide for AI-assisted coding in this repo.

## Required Reading

- Read `README.md` for project orientation and the documentation map.
- Read `docs/DEVELOPMENT.md` before changing code or developer tooling.
- Read `docs/ARCHITECTURE.md` and `PLAN.md` before storage, marketplace, sync, backup, deployment, or safety work.
- Read `docs/OPERATIONS.md` or `docs/MARKETPLACES.md` before changing operator commands or marketplace workflows.
- Read `UI_STYLE_GUIDE.md` before changing local ERP screens, CSS, layout, buttons, panels, tables, modals, responsive behavior, workflow copy, or shared UI helpers.

## Product Direction

- Keep the working inventory, printing, sync, review, CSV, backup, and scheduler workflows stable.
- Keep the app local and cheap by default. SQLite is the normal local database at `data/inventory.sqlite`.
- Keep JSON as backup/export/migration format, not the long-term working database.
- Keep the root ERP on the canonical local SQLite database. Do not add another root database driver without an explicit architecture decision.
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

## Required Task Workflow

Use this sequence for every development task. Do not skip a stage silently. If a stage cannot be completed safely, stop there and report the exact blocker.

### 1. Directions

- Read the complete request before editing.
- Identify the desired outcome, requirements, constraints, affected files and systems, acceptance criteria, and anything that must not change.
- When details are ambiguous, make the safest reasonable assumption and state it briefly.

### 2. Split

- Break the task into small, ordered, independently understandable, and testable work items.
- Identify dependencies and complete work in the required order.

### 3. Augment

- Gather the context needed to make the change correctly.
- Inspect the repository structure, relevant source, existing patterns, tests, documentation, configuration, dependencies, related issues or pull requests when available, and recent changes that may affect the task.
- Reuse established project patterns instead of adding unnecessary approaches.

### 4. Execute

- Implement one work item at a time and keep changes focused on the requested task.
- Preserve backward compatibility unless the request explicitly changes it.
- Add appropriate error handling and follow repository formatting and coding conventions.
- Update documentation when behavior, architecture, operations, or setup changes.

### 5. QA

- Compare the implementation directly with the acceptance criteria before running tests.
- Review for missing requirements, logic and edge-case errors, security or data-loss risks, broken imports or references, accidental unrelated changes, debugging code, secrets, unnecessary complexity, and inconsistent naming or formatting.

### 6. Test

- Run the checks required by the verification matrix below, including new focused tests for changed behavior.
- Do not ignore failures. Fix failures caused by the task and identify pre-existing or externally blocked failures precisely.
- Do not proceed unless relevant checks pass, except when an external limitation makes a check impossible and is explicitly reported.

### 7. Commit

- Review the final diff and create a focused commit containing only task-related changes.
- Use a clear, descriptive commit message.
- Never commit secrets, local data, temporary files, logs, generated artifacts that should remain untracked, or unrelated user work.

### 8. Push

- Push the focused commit to the appropriate remote branch and confirm the remote commit matches the reviewed local commit.
- Never force-push unless Josh explicitly requests it.

### 9. Merge

- Merge only when the work is complete, required checks pass, the branch is current, there are no unresolved conflicts, repository permissions and policies allow it, and the change is safe.
- Never bypass branch protection, required reviews, or failing checks.
- If direct merge is inappropriate, create or update a pull request and report what remains before merge.

### Final Report

Report the change summary, important implementation details, checks run, commit and branch, push or pull-request status, merge status, and any limitations, risks, or follow-up work.

The required sequence is: **Directions → Split → Augment → Execute → QA → Test → Commit → Push → Merge**.

## Verification Matrix

- Docs-only changes: run `npm run format:check` and `git diff --check`.
- Server/data behavior changes: run `npm test`, plus focused tests when available.
- Frontend/UI changes: run `npm run build`; run `npm run check:ui` after broad layout, shell, page, or visual changes.
- Shopify app changes: run `npm run shopify:typecheck` and `npm run shopify:lint`.
- Account-deletion Worker changes: run `npm run check:worker`.
- Full pre-commit confidence: run `npm run check`.

## Human Review Checklist

- Did UI work follow `UI_STYLE_GUIDE.md`?
- Did the change preserve SQLite/local-first assumptions?
- Did the change avoid exposing secrets or generated local data?
- Did the change avoid destructive marketplace behavior?
- Did the final response list what verification actually ran?
