# Armada skill installation and delivery review

The public CLI installer copies the Armada tool-knowledge skill for Claude Code
and Codex. See [Public Armada skill delivery](armada-skill-install.md) for
project and global install commands, revision pinning, and destination rules.

The delivery and review skills described below come from the repository's
`.agents/skills` directory. Use that directory from a reviewed checkout when
working with the manager workflow.

## Delivery review rollout

The repository's `.agents/skills` is the installer's source of truth; local
`.claude/skills` links to it, while installs copy both roots. A companion-skills
checkout in a snapshot uses its own installed skills. Audit that checkout and
existing installed packages for stale instructions rather than patching an
unrelated upstream repository.

Delivery stays owned by the worker: implementation, ship-pr-dev's unchanged
independent review gate, PR and green latest-head CI. It ends with READY TO MERGE
or BLOCKED and needs no Armada launch identity. The coordinator may then launch
an additional separate reviewer using its existing CLI or a sandbox parent's
scoped launch tool, never a worker credential.
See armada-manager/references/reviewer.md for launch commands, the minimal
issue/PR/review prompt, GitHub approval/request-changes, two-round budget,
corrections to the original worker and mandatory stop receipts.
The coordinator merges only an approved unchanged head with green CI and any
required Real-provider verification section. The worker's READY TO MERGE receipt alone does not authorize the coordinator to merge.
