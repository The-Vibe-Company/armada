# Retired browser CI measurement lane

The experimental [#1269 measurement lane](https://github.com/The-Vibe-Company/armada/issues/1269) and its `playwright.ci.config.ts` override have been retired. Historical measurements and exclusions remain in Git history; they are not current checks or promotion instructions.

Browser tests are manual-only. Use the ordinary `bun run e2e` configuration; no browser job or required e2e aggregate belongs in PR or merge-queue CI. Adding a CI job or required check remains the owner's decision.

See [merge-queue policy](merge-queue.md) and [CI budget](ci-budget.md) for the current checks. The full local browser suite and its assertions remain unchanged.
