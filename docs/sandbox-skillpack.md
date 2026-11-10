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
share tokens, custom origins and Skillpack credential injection are unsupported;
#841 owns that future credential contract. Skills are untrusted instructions,
not an isolation boundary. Golden default configuration, build-time installation
and a pinned/checksummed official CLI bootstrap are deferred to #868, as allowed
by #867's launch-first scope. No golden config field is accepted in this slice.

## Deployment
Apply `20261110190000_sandbox_skills.sql` before server rollout. No secret changes.
Coordinator deployed check (not performed in development): on Boat and Modal,
launch a compatible Skillpack-equipped golden with a currently public pin,
inspect status receipts and ask the first turn to read the installed skill.
An unavailable release must fail/stop without a first turn.

## Private-install integration seam (#841)
The owner requires private skills; this public-only slice does not satisfy that
requirement by itself. #841 owns encrypted user/org credential resolution and
command-only ephemeral environment injection. PR #872 (codex/841-private-skillpack-skills) is the consumer of this seam.
The server-only installSkill helper
accepts a trusted SkillInstallTransport closure: it receives separate install and
receipt-read commands and must return lock output only after successful install.
This keeps credential transport out of reference validation and receipt parsing;
#841 can reuse both without rewriting the public path. No request/config accepts
a transport or credential. Catalog receipt validation remains catalog-only;
#841 must explicitly validate its private workspace provenance contract.

Never use credential-bearing transports for golden builds, write a Skillpack
login/profile, add credentials to golden config or sandbox persistent environment,
or snapshot a credential-bearing builder. #868 must remain public-only and build
with no credentials; private installs belong only in fresh, non-snapshotted
launch sandboxes. No golden build code is introduced or changed here.

## Worker checkout hygiene
When --repo selects a checkout, successful installs add the project lock file and its persistent .lock sibling
and installed shared .agents skill paths (plus .claude copies for Claude) to Git's local info/exclude file
(resolved with git rev-parse, including worktrees). This metadata is never
committed, so git add -A does not sweep these untracked launch artifacts into
the worker's PR. Failure to prepare exclusions fails the launch before a turn.
Git exclusions do not hide already tracked files; existing tracked skills remain
subject to Skillpack's conflict rules and normal Git review. Without --repo,
installation remains at the golden root, outside the selected coding checkout.
