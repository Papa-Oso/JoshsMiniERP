# Contributing

## Before Changing Code

Read `AGENTS.md`, then follow its links for the area being changed. Preserve the local-first SQLite model, marketplace write boundaries, and UI conventions.

Never commit or share `.env`, OAuth tokens, database credentials, files under `data/`, browser profiles, or real customer/marketplace records.

## Workflow

1. Start from a clean understanding of `git status`.
2. Keep changes focused and avoid unrelated refactors.
3. Add focused tests for behavior changes.
4. Update the canonical documentation when a command, workflow, safety boundary, or architectural decision changes.
5. Run the verification matrix in `docs/TESTING.md`.
6. Review the final diff for secrets, generated files, destructive marketplace behavior, and accidental changes to local-first assumptions.

## Commit and Review Guidance

- Use a short imperative commit subject.
- Explain why the change is needed, not only which files changed.
- List verification actually performed and checks intentionally skipped.
- Call out migrations, credential changes, backup requirements, and live marketplace effects prominently.
- Keep live marketplace writes out of tests and ordinary review environments.

## Documentation Ownership

- `README.md`: orientation and quick start
- `docs/DEVELOPMENT.md`: developer workflow and scripts
- `docs/OPERATIONS.md`: operator commands and recovery
- `docs/MARKETPLACES.md`: marketplace setup and safety
- `docs/ARCHITECTURE.md`: durable system design
- `PLAN.md`: active and upcoming work only
- `CHANGELOG.md`: completed user-visible changes

Prefer linking to one canonical explanation over copying long instructions into multiple files.
