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

Raising an AGENTS.md byte budget is the owner's decision.

## Architecture counters

Shard 1 compares the working tree with the fetched PR or merge-queue base. Each
enabled counter may stay equal or decrease across the repository. Moving a
match between files in scope does not consume a per-file allowance. An increase
reports the base and head totals and the locations of new matches.

- `provider-branch` counts strict comparisons and case labels for Boat, Modal,
  and Docker, plus `switch (provider...)` on the provider identifier in the
  architecture metric’s scope. Provider packages, Docker host, and the machine
  adapter files listed in `scripts/metrics/architecture-rules.ts` are excluded.
- `versioned-route` counts route-name literals with a `-vN` segment suffix in
  `control*.ts` under the server source directory.
- `deprecation-header` counts `Deprecation` and `Sunset` header names in non-test
  server TypeScript.
- `native-path` requires zero provider-run references in the architecture metric’s scope.
  The two stored launch fingerprint discriminators keep their original bytes.
- `append-point` counts central control routes, server workers and mounts, core
  barrel exports, and CLI command table entries.

Run `bun scripts/ci/ratchets.ts [base]` locally. Without a base argument or
`origin/main`, it prints working-tree totals. These counters are trend
alarms. Import boundaries and table owners enforce their respective contracts.
