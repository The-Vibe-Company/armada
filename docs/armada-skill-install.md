# Public Armada skill delivery (#986, infrastructure slice)

The tool-knowledge skill and command/flag drift check shipped in #1003.
The current pin includes the reviewed wait/recovery correction from #1073,
including the skill and its recovery reference; it does not claim unrelated
routine additions from #1027.
Authoring/evaluation provenance is in [armada-skill-evaluation.md](armada-skill-evaluation.md).

## Investigation and recommendation

Recommend the existing API-independent public GitHub installer as the baseline:

```sh
armada skill install --global --yes
# Or a project-local install for both agents:
armada skill install --project . --yes
```

This is the same noninteractive command for a human or agent. It requires Git,
not Armada login, provider credentials, a Skillpack key, or a Node package
manager. By default it fetches the reviewed recovery-content commit
edae17036da335f41e91af7e6ade7a42473d6a45 and reports that commit. An exact
40-character commit can be selected with --revision. The complete
.agents/skills/armada directory, including setup/recovery references, is copied
to both agent roots. The legacy armada-manager/review bundle is not installed.

The package names, reviewed revision, source directory and discovery roots are
centralized in packages/cli/src/skill-package.ts. Update that reviewed pin with
future skill releases; do not silently track mutable main.

| Option | Public install | Updates | Recommendation |
| --- | --- | --- | --- |
| Existing Armada GitHub installer | Already implemented; no registry key | Explicit commit selection, refuses existing directories | Baseline: ships with CLI, shared Claude Code/Codex copy flow |
| Skillpack public catalog | Native CLI supports org/slug, exact version, tool selection and pinning | Managed update/sync and receipts | Add as optional channel after the owner publishes a public package |
| Private Skillpack package | Requires authorized registry access | Managed by owner/coordinator | Authoring dependency only; not an acceptable public delivery prerequisite |

No public Skillpack catalog package is required for this installation, and this
PR publishes none. Skillpack itself remains Armada-independent.

### Update and discovery contract

Project installs write .agents/skills and .claude/skills; global installs use
those roots under the user's home. No settings file is rewritten. Start a fresh
Codex or Claude Code session after installation. Tests verify complete references
in both roots and preservation of unrelated settings. The clean-home public
installation check verifies both copies and hint suppression; it is not a live
model session or staging sandbox operation.

There is no automatic overwrite or background update. For an explicit update,
review/back up customized skill directories, remove only the managed directories
you intend to replace, then rerun with a reviewed --revision. Do not delete an
entire agent skills root. A later managed-update implementation should use
checksummed receipts and refuse modified content rather than silently replacing it.

## Hint design and implementation

- Printed to stderr only after a successful interactive CLI command.
- Both stdout and stderr must be terminals: JSON, pipes, redirected output/errors
  and failed commands stay quiet. The installer/help route itself stays quiet.
- Silence permanently with ARMADA_NO_SKILL_HINT=1.
- Once per seven days per local user state directory, across projects/servers.
  The receipt is XDG_STATE_HOME/armada/skill-hint, defaulting to
  ~/.local/state/armada/skill-hint. Unwritable state means no hint.
- Local file checks only: no authentication, subprocesses, network, polling,
  timers, remote registry checks or package downloads to decide.
- Check the configured primary skill's SKILL.md in user and ancestor project
  .agents, .claude and .codex roots (ancestor walk capped at 32 directories).
  An installed armada skill suppresses the hint; the hint is not a
  package-integrity checker.
- The cooldown is best-effort under concurrent invocations. It is not a global
  lock or telemetry. No identity, server or credential is stored.
- Constants target only the released armada tool-knowledge skill.

## Evidence

The real CLI entrypoint is exercised through a pseudo-terminal with a clean
temporary home: first hint, cooldown, aged receipt, opt-out, JSON, pipes,
discovery in each root and ancestor project, and unusable state. Installer tests
use a real local Git repository redirected from the public URL; they verify
pinned checkout and both agent copies without network. No live staging,
production, or live model-session claim is made. The public default-pinned
installer was also run in a clean temporary HOME with no Armada/Skillpack
credentials: both agent roots contained SKILL.md and setup/recovery references.
The interactive hint appeared before install; after install it stayed quiet
even after deleting the cooldown receipt (discovery, not throttling, suppressed it).
