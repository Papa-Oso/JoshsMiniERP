# Shopify App Agent Instructions

These instructions supplement the repository-root `AGENTS.md`.

- Read this directory's `README.md` before changing the embedded app.
- Keep inventory ownership in the root ERP. This app is an authenticated Shopify Admin surface and ERP client.
- Use Shopify Admin components and patterns; do not copy the local ERP visual theme into the embedded app.
- Keep `ERP_API_TOKEN` in server-only code and environment configuration.
- Preserve Shopify authentication, session storage, webhook validation, and required scopes.
- Do not contact live marketplace APIs from automated tests.
- Run `npm run typecheck` and `npm run lint -- --max-warnings=0` for changes in this directory.
