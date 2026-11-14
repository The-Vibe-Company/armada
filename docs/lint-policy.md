# Lint policy

`bun run lint` runs Biome's recommended checks and formatter. A clean checkout
should produce no warnings or infos, so new diagnostics remain visible. We do
not hide diagnostics, change the failure threshold, or disable whole rule groups.

The root `biome.json` makes these deliberate exceptions:

- `noNonNullAssertion`: assertions are permitted for validated inputs, indexed
  fixtures and framework contracts. This syntactic ban cannot establish runtime
  safety; strict typechecking remains enabled.
- `useTemplate` and `useOptionalChain`: concatenation and explicit guards are
  accepted styles; mass rewrites add churn rather than fixing behavior.
- `noExplicitAny`: explicit escape hatches are permitted at dynamic SDK, mock and
  wire boundaries. TypeScript's implicit-any checks remain enabled.
- `noConfusingVoidType`: async callback contracts deliberately allow a result or
  no result (`Promise<T | void>`). Replacing void with undefined can change which
  callback implementations TypeScript accepts.

`noTemplateCurlyInString` is disabled only in the two core files that embed shell
parameter expansions as quoted data. Those expressions belong to the shell,
not JavaScript. Other intentional exceptions use local suppressions with
rationale: reduced motion, a non-secret preference cookie, and awaiting process
exit in an admission test, plus a shell parameter expansion fixture. Other recommended rules stay enabled.

Fix meaningful diagnostics. For intentional patterns, use the narrowest exception
and explain it; do not apply repository-wide unsafe fixes or introduce a new CI
gate. Verify with the existing `bun run lint` command.
