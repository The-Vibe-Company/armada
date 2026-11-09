# Install the Armada manager skill

Install public, repository-owned instructions for **both Codex and Claude Code**, without logging in to Armada, Supabase or Skillpack:

```sh
armada skill install --project /path/to/project --yes
armada skill install --global --yes
# Reproduce an audited source commit:
armada skill install --project /path/to/project --yes --revision <full-40-character-commit>
```

Choose exactly one scope. Project installs copy to `<project>/.agents/skills` (Codex) and
`<project>/.claude/skills` (Claude Code). Global installs use `~/.agents/skills` and
`~/.claude/skills`, the agents' default discovery roots. Custom agent-home environment
overrides are not interpreted; use project scope when you need a specific target.
The directory may be new. No agent configuration files are edited.

The command requires Git on PATH and public HTTPS GitHub access. It uses a small
Git/filesystem adapter, not an embedded skill or a downloaded executable. The
[upstream skills API](https://github.com/vercel-labs/skills/blob/main/docs/api.md)
requires Node 22.20+, so this adapter avoids changing Armada's Node >=18 launcher
requirement or depending on unverified compatibility with the compiled Bun runtime.

By default the installer fetches current `main` from
[The-Vibe-Company/armada](https://github.com/The-Vibe-Company/armada),
resolves it to an immutable commit, and copies the complete `.agents/skills`
packages: `armada-manager`, `ship-pr-dev`, `review-code-dev` and
`capture-learning-tools`. Scripts and references are included, not just SKILL.md.
It prints the exact GitHub commit URL and all eight installed package destinations.
Use `--revision` to pin a known commit; it must contain every required package.

`--yes` explicitly approves this noninteractive operation. Without it the command
returns usage; it never waits for stdin. Existing skill directories (even identical
ones) and symlinked parents are refused before copying. There is no force/update
option: inspect and manually back up or move existing packages before reinstalling.
Unrelated skills and configuration are preserved. A failed copy removes only the
new package directories created by this invocation; empty parent directories can
remain. Concurrent modification of the destination during installation is not supported.

Installing instructions does not execute their scripts or install their external
tools. Review the pinned source before letting an agent follow it. The review
dependency's portable bootstrap may download its pinned OCR binary when later used.
