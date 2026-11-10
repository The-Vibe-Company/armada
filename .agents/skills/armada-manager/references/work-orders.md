# Work orders and continuity

Keep a handoff self-contained but narrow:

- Issue and desired behavior, acceptance criteria, approved side effects and explicit exclusions.
- Repository, base, branch/worktree and files the worker owns; another worker owns a shared file or contract explicitly.
- Harness/model requested by the user, or the instance's supported default.
- Actual producer contract/source revision and dependency order; identify what can proceed now.
- Same-session `ship-pr-dev`, appropriate verification, evidence location and final ready receipt.
- Integrator destination, merge authority and the compute completion condition.

An example handoff shape:

```text
Own issue <id> in <repo>, branch <branch>, isolated worktree <path>.
Implement <observable result>; preserve <specific existing behavior>.
Your scope is <files/module>; <owner> owns <shared contract/files>.
Consume <producer revision>; independent work can proceed before it merges.
Complete ship-pr-dev here, fix findings and latest-head CI, then hand READY FOR REVIEW
with exact head, self-check/evidence paths and deployment prerequisites to <integrator>.
Keep compute warm through review, CI and integration. Report completion so the
coordinator can verify the role is terminal before stopping it.
```

For a resume, read the ledger and actual branch/PR/runtime state before sending instructions. Preserve uncommitted work and coordinator reviewer receipts; the coordinator launches any new round on changed source. An apparent missing result may be an in-flight command, stale ledger entry, queued continuation or transport failure; inspect that boundary before replacing the worker.

The ledger need not be a new system. A small local file containing current facts and artifact pointers is enough. Update on phase, source, ownership, deadline or outcome changes. Separate candidate evidence from final shipping evidence. Never infer ownership from a familiar resource name.

## Drift and feedback

Send one precise correction with its evidence and the affected acceptance criterion. Routine contract updates wait for a natural checkpoint. A newly urgent correction on the same ticket may justify re-steering at a safe boundary; preserve its source and unfinished gates first. A separate ticket receives a dedicated agent instead of borrowing an existing one.

When multiple workers share a module, nominate the writer and relay the actual patch/type revision. Use normal branch updates and focused affected review after integration. Avoid repeated whole-fleet rebases or full review boards merely because unrelated main files changed.
