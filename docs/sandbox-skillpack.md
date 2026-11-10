# Skillpack skills at sandbox launch

`armada launch GOLDEN --agent codex --skill example/notes@1.0.0 --skill example/other@2.0.0`
installs public catalog exact pins before the first turn, including idle launches.
API/MCP launch accepts `skills: string[]`; delegated child launch accepts the
same array in `selection`. At most 20 distinct slugs are accepted; ambiguous
versions or cross-organization slug collisions are rejected before allocation.

The golden must contain the native Skillpack CLI on PATH. Armada uses the same
official-origin native installer and lock receipt validator as orchestrator create
(#839), installs for the chosen harness into the selected repository or golden
root, and records verified UUID/version/checksum/origin receipts in sandbox
detail/status. No skills means no CLI requirement. Existing files/defaults are
left to Skillpack's managed conflict rules; this does not remove snapshot skills.
Partial installation or invalid provenance fails the launch, stops the machine,
and starts no agent. Guest diagnostics are not returned.

Only currently advertised public catalog exact releases work. Private skills,
share tokens, custom origins and Skillpack credential injection are unsupported
for ordinary sandbox/child launches in this public-only slice. #872 now supports
private orchestrator create via the existing encrypted credential contract. Skills are untrusted instructions,
not an isolation boundary. Golden default configuration, build-time installation
and a pinned/checksummed official CLI bootstrap are deferred to #868, as allowed
by #867's launch-first scope. No golden config field is accepted in this slice.

## Deployment
Apply `20261110192000_sandbox_skills.sql` before server rollout. No secret changes.
Coordinator deployed check (not performed in development): on Boat and Modal,
launch a compatible Skillpack-equipped golden with a currently public pin,
inspect status receipts and ask the first turn to read the installed skill.
An unavailable release must fail/stop without a first turn.

## Reconciliation with private installation (#872)
The owner requires private skills. #872 now provides encrypted user-over-org
credential resolution and the shared server-only installPrivateSkill boundary,
including pinned SSH stdin transport, command-only ephemeral environment,
workspace provenance, key cleanup and sanitized errors. Orchestrator bootstrap
reuses that implementation unchanged for bare private pins and reuses this
module's public command/receipt helpers for qualified anonymous catalog pins.
Qualified pins never resolve/send a private credential. The previously proposed
SkillInstallTransport hook was unused by #872 and is removed: no parallel
credential or installer mechanism is introduced.

Ordinary sandbox and delegated child launch remain explicitly public-only;
bare private pins are rejected before allocation even though orchestrator create
accepts them. A future private launch caller must reuse installPrivateSkill and
resolveSkillpackCredential, not copy their transport or registry validation.
Defaults/version resolution remain #841 work; golden defaults remain #868.
Never persist Skillpack credentials in a golden snapshot, login/profile, config
or persistent environment. No golden build code is introduced here.

## Worker checkout hygiene
When --repo selects a checkout, successful installs add the project lock file and its persistent .lock sibling
and installed shared .agents skill paths (plus .claude copies for Claude) to Git's local info/exclude file
(resolved with git rev-parse, including worktrees). This metadata is never
committed, so git add -A does not sweep these untracked launch artifacts into
the worker's PR. Failure to prepare exclusions fails the launch before a turn.
Git exclusions do not hide already tracked files; existing tracked skills remain
subject to Skillpack's conflict rules and normal Git review. Without --repo,
installation remains at the golden root, outside the selected coding checkout.
