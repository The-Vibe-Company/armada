# Machine sizing v1

Source of truth: browser-safe `@armada/core` exports from
`packages/core/src/machine-size.ts`, including policy request/result DTOs.

## Transport

- POST `/api/v1/golden/size-policy`: `MachineSizePolicyRequest` -> `MachineSizePolicyResult`.
  Omit policy to read. Supply a complete version-1 policy to replace atomically.
  Clear with `{version:1,golden:null,repositories:{}}`.
- MCP `golden_size_policy` uses the same fields and result.
- HTTP `sandbox/launch` and MCP `launch` accept optional `size`:
  `small | medium | large | xlarge`. Boat's native `default` is canonical `medium`.
- Evidence: HTTP launch `sandbox.machineSize`; MCP launch/list/status/wait
  `machineSize` (list: each sandbox). SQL `sandboxes.machine_size`.

Override > explicitly selected repository default > golden default > legacy.
No selected repository means no repository default, even for a single-repository
golden. Repository selectors use the existing configured directory or owner/repo
resolver. Policy keys must be configured directories, returned in the policy
result. Config replacements prune defaults for removed directories atomically.

Defaults are per provider golden, **not shared** between Boat and Modal goldens
for the same org/repository. Org writes require live admin membership; private
writes require the owner and live membership. Policy writes do not rebuild
snapshots, restart or resize existing machines. Launch evidence is immutable.

## Capacity and compatibility

Nominal tiers are 2/4/8/16 vCPU and 4096/8192/16384/32768 MiB.
Boat uses small/default/large/xlarge native types (public table calls RAM GB).
Modal requests 1/2/4/8 physical cores and the listed MiB, with CPU and memory
limits equal to requests. This deliberately caps bursting for explicit tiers;
it does not promise equivalent hardware, performance or billing.

No configured selection preserves legacy behavior: Boat inherits its snapshot
type; Modal leaves resource arguments omitted (SDK default requests are
0.125 physical cores / 128 MiB, potentially bursting). Effective size and
capacity remain null, not medium. Historical rows are null, with no backfill.

Capacity provenance `requested-provider-resources` records allocation settings,
not independently observed hardware or measured utilization. Provider plan,
quota, availability and disk constraints can still reject allocation. Boat
xlarge needs an eligible plan; shrinking may return `type_too_small`.
There is no automatic retry at a larger size or fallback. SDKs expose no reliable
preflight for source disk fit; the native refusal is authoritative.

## Deployment

Apply additive migration `20261110120600_machine_size_policy.sql` before
deploying this server. Older servers tolerate the nullable additions; new
servers require them. No active compute changes or production migrations
are performed by this PR. Modal's persisted registry adds an optional size
field, so old machine records preserve omission on resume.

Verified sources: [Boat](https://boat.dev/),
[Modal sandbox resources](https://modal.com/docs/guide/sandbox-resources),
[Modal CPU/memory](https://modal.com/docs/guide/resources), and installed
Boat 1.13.0 / Modal 0.11.1 TypeScript SDK models.
