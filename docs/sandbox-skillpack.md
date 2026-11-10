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
