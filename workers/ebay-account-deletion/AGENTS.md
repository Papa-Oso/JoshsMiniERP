# eBay Account Deletion Worker Agent Instructions

These instructions supplement the repository-root `AGENTS.md`.

- Keep this Worker limited to eBay Marketplace Account Deletion compliance.
- Never expose the notice feed without its admin bearer-token check.
- Do not log notification payloads, verification tokens, or admin tokens.
- Preserve eBay challenge verification behavior and processed-notice tracking.
- Do not add inventory, dashboard, or marketplace-sync behavior to this Worker.
- Run `npm run check:worker` from the repository root after changes.
