# Boat runtime skills staging check (#1161)

The opt-in Boat runtime now uses the **existing** launch `skills` pins and
`skipSkillDefaults` policy (environment → organization → personal → explicit
pin overrides). There is no public skill setup endpoint or second installer.
After enrolled readiness and before automatic MCP setup / first inference, the
launcher sends a private, epoch-fenced install command. Receipts are persisted
in `sandbox.skills`, just as for native launches. Failure stops the launch;
there is no SSH / Boat native runner fallback.

Qualified public pins install anonymously. Bare private pins use the existing
actor-scoped Skillpack credential in Armada's encrypted vault; it reaches only
the fixed foreground installer child's environment. It is not a model
credential, command argument, journal entry or API receipt. The guest validates
pinned lockfile/checksum/target/workspace receipts and adds native-equivalent
Git exclusions. Revocation/shutdown cancels the owned process group before the
runtime closes its journal. Old runtime artifacts refuse before key delivery.
Resume retains project files, including user edits, without reinstalling.
Arbitrary enrolled `exec` remains disabled.

## ONE staging launch, batched with MCP / GitHub / checkpoint / resume

Use the **armada-server staging HTTPS origin** and the same existing Armada
login/token, organization, golden and Codex credential inputs documented in
[the MCP check](boat-runtime-mcp.md). The existing connected default-for-launch
remote MCP connection/tool inputs and linked GitHub repository are unchanged.
**Do not supply skill pins, SKILL.md substrings or a Skillpack key.**

```bash
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --skills --mcp --github --resume
```

Like the existing [post-deploy smoke](post-deploy-smoke.md)'s `--default-skills`
mode, this reuses `readDefaultPins` / `verifyDefaultReceipts` from
`scripts/default-skill-smoke.ts`. Before allocating it resolves the selected
Boat golden in the organization using `golden/list`, then reads
`skills/defaults/get` for `golden` (with that golden ID), `org` and `personal`
scopes, applying the same independent slug-precedence oracle. If the effective
pins are empty, it stops with **"No default skills configured for the smoke
golden/org/user; no launch attempted."** It neither configures defaults nor
spends compute to discover that precondition.

The runtime launch sends **no explicit `skills` and no `skipSkillDefaults`**.
Its returned receipts and persisted `sandbox/status.skills` must match all
and only the API-discovered effective pins, including exact versions, valid
IDs/checksums/origin and identical launch/status receipt fields. Missing,
extra or mismatched receipts fail. The launch golden must match the preflight
golden. Status receipts are checked again after stop and after resume; no
file-content canary or additional skills-only model turn is needed. Private
pins use the existing actor-scoped Armada vault credential, never a new input.
The check proves the defaults actually configured, not hypothetical public/
private coverage when one kind is absent.

Server and pinned guest artifacts must come from the skills-capable revision:
`launch/options.boatRuntime.skillsVersion === 1`. Artifacts are published by
the server image, **not** manually. The golden needs its existing Skillpack CLI.

Expected: one sandbox allocation, four same-conversation prompts, one explicit
checkpoint/resume activation (epoch +1), two stops, no allocation retry. The
same run requires answers and finished events from archived
`source: armada-runtime`, successful MCP server/tool/exact-argument provenance,
current-epoch GitHub credential acquisition, original remembered token and
stopped history. Final output includes `skills: verified`,
`skillsAfterResume: verified`, `mcpAfterResume: verified`,
`githubAfterResume: verified` and `resume: verified`. Stop on failure; report
the sandbox ID and reason rather than spending another Boat start.

Local tests exercise the real guest subprocess/Skillpack lockfile protocol
with an offline CLI peer, cancellation of descendants, Core default merging /
launch ordering and old-artifact/epoch/key-delivery guards. The deployed check's
actual entrypoint is also driven offline: no-defaults allocates nothing;
configured defaults launch without explicit pins; mismatched golden/status
receipts fail and stop the known sandbox. No network, sleeps or new test seam.
Real staging parity remains pending the coordinator's check. Claude admission
is a later slice; this does not enable it or change native/default routing.
