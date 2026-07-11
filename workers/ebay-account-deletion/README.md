# eBay Account Deletion Worker

Tiny Cloudflare Worker used only for eBay Marketplace Account Deletion compliance.

It supports:

- `GET ?challenge_code=...` for eBay endpoint verification.
- `POST /ebay/marketplace-account-deletion` for Marketplace Account Deletion notifications.
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

Use `https://...workers.dev/ebay/marketplace-account-deletion` as the eBay notification endpoint. The dedicated path is required: POST requests to other paths are rejected without touching KV.

The verification token must be the same value pasted into eBay's Alerts & Notifications page.

Before deploying this version, update the endpoint in eBay's Alerts & Notifications page to include `/ebay/marketplace-account-deletion`; eBay will issue a new verification challenge. Notifications must use JSON, contain the expected deletion topic and identifiers, and include `X-EBAY-SIGNATURE`. Duplicate notification IDs are acknowledged without another KV write.

The signature header requirement filters ordinary scanners but is not cryptographic sender verification. Add eBay public-key signature verification before treating the stored notice as authenticated.

Add the admin token and endpoint to the local ERP `.env` so an operator can explicitly inspect stored notices. Automatic polling is disabled because listing the current KV layout reads every stored notice:

```env
EBAY_DELETION_NOTICES_URL=https://example-worker.workers.dev
EBAY_DELETION_NOTICES_TOKEN=<same value as EBAY_NOTIFICATION_ADMIN_TOKEN>
```

Use the actual deployed Worker URL only in ignored local configuration and the eBay developer console. Do not record production tokens in this file.
