# Security Policy

## Reporting

Do not open a public issue containing a vulnerability, token, credential, customer record, inventory database, marketplace listing export, or production URL with protected parameters. Report security concerns privately to the repository owner through a trusted private channel.

Include only the minimum reproduction information. Redact tokens, authorization headers, cookies, database URLs, OAuth codes, listing/customer data, and files under `data/`.

## Secrets

- Local secrets belong in ignored `.env` or ignored token files under `data/`.
- Production secrets belong in the deployment platform's secret manager.
- Never commit real secrets, even temporarily.
- If a secret may have been exposed, revoke or rotate it before attempting repository cleanup.
- Do not rely on deleting a commit to make an exposed credential safe.

## Deployment Boundary

The API binds to localhost by default. Production must set `NODE_ENV=production`, configure a strong `ERP_API_TOKEN`, use HTTPS, and store secrets outside source control.

## Marketplace Safety

Legacy eBay listings are protected assets. Quantity writes, bulk revisions, relisting, or migrations require explicit review beyond normal code-change approval. Security fixes must not silently broaden marketplace write permissions.

## Supported Version

This personal project currently supports only the latest state of the default branch. Apply security fixes there and redeploy affected services after review.
