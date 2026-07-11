# eBay Account Deletion Worker

Tiny Cloudflare Worker used only for eBay Marketplace Account Deletion compliance.

It supports:

- `GET ?challenge_code=...` for eBay endpoint verification.
- `POST` for Marketplace Account Deletion notifications.
- `GET /notices` for the local ERP to poll stored notices with an admin bearer token.
- `POST /notices/:id/processed` for marking a notice processed.

The local ERP remains local. This endpoint does not expose the dashboard, inventory database, or API.

## Local Test

```powershell
node workers/ebay-account-deletion/test-worker.mjs
```

## Deploy

```powershell
cd workers/ebay-account-deletion
npx wrangler login
npx wrangler kv namespace create EBAY_DELETION_NOTICES
npx wrangler secret put EBAY_VERIFICATION_TOKEN
npx wrangler secret put EBAY_NOTIFICATION_ADMIN_TOKEN
npx wrangler deploy
```

Use the deployed `https://...workers.dev` URL as the eBay notification endpoint.

The verification token must be the same value pasted into eBay's Alerts & Notifications page.

Add the admin token and endpoint to the local ERP `.env` so an operator can explicitly inspect stored notices. Automatic polling is disabled because listing the current KV layout reads every stored notice:

```env
EBAY_DELETION_NOTICES_URL=https://example-worker.workers.dev
EBAY_DELETION_NOTICES_TOKEN=<same value as EBAY_NOTIFICATION_ADMIN_TOKEN>
```

Use the actual deployed Worker URL only in ignored local configuration and the eBay developer console. Do not record production tokens in this file.
