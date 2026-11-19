# Skillpack skills at sandbox launch

`armada launch SNAPSHOT --provider boat --agent codex --skill example/notes@1.0.0 --skill example/other@2.0.0`
installs exact public catalog pins before the first turn, including for idle
launches. Use `slug@version` for a private workspace pin and
`org/slug@version` for a public pin. API and MCP launch accept `skills: string[]`.
Delegated child launch accepts the same array in `selection`. The effective
list can contain at most 20 distinct slugs. See [default pins](skill-defaults.md)
for precedence and [private installation](private-skillpack.md) for key setup.

The snapshot must contain the native Skillpack CLI on PATH when there are
effective pins to install. Armada installs skills for the chosen harness into
the selected repository or snapshot root. Sandbox details include verified
installation receipts with the exact version, checksum, and origin. Existing
files are subject to Skillpack's managed conflict rules. If installation or
receipt validation fails, the launch stops before the first turn. Armada returns
a classified failure and keeps guest diagnostics private.

## Worker checkout hygiene

When `--repo` selects a Git checkout, Armada adds the lockfile, its persistent
`.lock` sibling, and the installed skill paths under `.agents` (plus `.claude`
copies for Claude) to the checkout's Git exclude file. This keeps generated,
untracked skill files out of a worker's commit. Tracked files still appear in
Git review. If Armada cannot prepare the exclusions, the launch stops before the
first turn. Without `--repo`, installation targets the snapshot root.
