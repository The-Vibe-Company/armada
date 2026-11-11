# Public Armada skill delivery (#986, infrastructure slice)

Skill content is deliberately excluded. The owner requires the private Skillpack
skill-creator, pinned by the coordinator, before authoring resumes. No package
version or evaluation is claimed here.

## Investigation and recommendation

Recommend the existing API-independent public GitHub installer as the baseline:

```sh
armada skill install --global --yes
# Or a project-local install for both agents:
armada skill install --project . --yes
```

This is the same noninteractive command for a human or agent. It requires Git,
not Armada login, provider credentials, a Skillpack key, or a Node package
manager. It resolves public main to a commit before copying and reports that
commit. An exact 40-character commit can be selected with --revision.
The current installer copies the **legacy armada-manager bundle and its review
dependencies**, not the pending tool-knowledge skill. The hint does not claim
otherwise. It changes no orchestration method or skill content.

The package names, source directory and discovery roots are centralized in
`packages/cli/src/skill-package.ts`. After authorized authoring, replace that
selection and adjust installer help in the same content/packaging PR. Do not
point the installer at a missing or unpublished package.

| Option | Public install | Updates | Recommendation |
| --- | --- | --- | --- |
| Existing Armada GitHub installer | Already implemented; no registry key | Explicit commit selection, refuses existing directories | Baseline: ships with CLI, shared Claude Code/Codex copy flow |
| Skillpack public catalog | Native CLI supports org/slug, exact version, tool selection and pinning | Managed update/sync and receipts | Add as optional channel after the owner publishes a public package |
| Private Skillpack package | Requires authorized registry access | Managed by owner/coordinator | Authoring dependency only; not an acceptable public delivery prerequisite |

Skillpack CLI 0.3.5 was inspected via its real --help/install help. Anonymous
inspection/installation of skill-creator returns code 3 (no API key). No public
Armada tool-skill catalog pin currently exists in this change, and no package
was published. Skillpack itself must remain Armada-independent.

### Update and discovery contract

Project installs write .agents/skills and .claude/skills; global installs use
those roots under the user's home. No settings file is rewritten. Start a fresh
Codex or Claude Code session after installation. Existing tests verify both
copies and preserve unrelated settings; actual fresh-agent discovery of the new
tool skill remains a gate for its content/packaging follow-up, not evidence
claimed by this infrastructure PR.

There is no automatic overwrite or background update. For the legacy installer,
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
  An installed primary skill suppresses the hint even if optional dependencies
  are missing; the hint is not a package-integrity checker.
- The cooldown is best-effort under concurrent invocations. It is not a global
  lock or telemetry. No identity, server or credential is stored.
- Constants currently target the already-public legacy bundle. Moving to the
  authored skill does not require redesigning output, cooldown or discovery.

## Evidence

The real CLI entrypoint is exercised through a pseudo-terminal with a clean
temporary home: first hint, cooldown, aged receipt, opt-out, JSON, pipes,
discovery in each root and ancestor project, and unusable state. Installer tests
use a real local Git repository redirected from the public URL; they verify
pinned checkout and both agent copies without network. No live staging,
production, or fresh-agent tool-skill acceptance claim is made.
