# Armada tool skill evaluation (#986)

Authored with Skillpack's private `create-skill-tools` 1.1.1
(package da943979-69aa-4031-841f-a629d25233f6). The portable skill is
`.agents/skills/armada`; installer/hint integration belongs to #988.

## Method and bounded iteration

Intent: terminal tool knowledge, not a coordination method. Sources: current CLI
root help, dedicated template/vars/secrets/skill help and 101 subcommand help
probes. Many leaf commands do not implement help; root usage is their public
contract. No staging credentials were available.

Two isolated agents produced dry-run guidance with and without the skill for
five realistic prompts (launch, waiting, template retry, stopped/unpushed work,
and sandbox callers with unauthorized merge pressure). Both scored 15/15 on the
initial advice rubric: **a non-discriminating result, not proof of correctness**.
Independent review caught a missed private-pin mistake: qualified org/slug pins
are anonymous public catalog lookups even when a credential is configured.

The revision uses bare private slugs and explicitly explains the distinction.
All five cases were rerun, plus an unused held-out qualified-private-pin trap.
With-skill scored 18/18; baseline 16/18, missing both catalog/workspace syntax
checks on the held-out case. These are small, single-run advice evaluations,
not measured improvements in live execution, timing, token use or agent discovery.
The durable prompts/contracts are in `evals/evals.json`. Benchmark JSON,
qualitative answers, grading and static review HTML were generated with the
creator's `eval-viewer/generate_review.py` under the ignored run workspace.
No human feedback or live success is claimed. The creator's packager validates
and packages the portable skill (excluding evals).

## Regression prevention

`bun test scripts/armada-skill.test.ts` checks documented Markdown invocations
against the running CLI help, with command-scoped flags and negative controls.
Write every command as a single inline code span or one fenced line beginning
with `armada`; do not hide commands in prose or split them over shell lines.
Quoted prompt/exec payload is data, not CLI flags. This gate detects documented
command/flag removal, not semantic API changes or provider compatibility.

## Outstanding coordinator checks

Use staging only: real Boat/Modal private-pin authorization and receipt/activation,
GitHub refresh, golden/template retry recovery, readable configuration, turn
operations and lifetime/recovery. After #988 selects this skill, exercise public
pinned install into clean Claude Code/Codex roots, fresh-session discovery, hint
suppression, preservation of existing files and reviewed explicit updates.
No automatic sandbox authentication/bootstrap is assumed; check what is merged
and deployed before validating a sandbox driving other sandboxes.
