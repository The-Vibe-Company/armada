# Task outcome v1

A task outcome is an explicit declaration, not Armada's verification of a PR.
It is independent of machine status and prompt execution status.
The browser-safe `TaskOutcome` type is exported by `@armada/core`:

- `{ state: "ready", prNumber?, prUrl?, headSha? }`
- `{ state: "blocked", reason }` (1–1000 non-whitespace characters)
- `null`: no outcome reported for this turn. This does not mean success.

After `wait` shows that the latest prompt finished, its authenticated owner or a
current organization admin can report that prompt's outcome:

```sh
armada report <sandbox-id> ready --prompt-id <prompt-id> \
  --pr-number 42 --pr-url https://github.com/example/repo/pull/42 \
  --head-sha <full-40-character-sha>
armada report <sandbox-id> blocked --prompt-id <prompt-id> --reason "Needs an owner decision"
```

MCP tool `report` and POST `/api/v1/sandbox/report` take
`{ id, prompt_id, outcome }`. Reports can replace a previous declaration for
the same turn. A running, interrupted, failed, old, or missing turn cannot be
reported. Legacy turns started before this contract cannot be reported; start
a new turn first. No ambient sandbox credential or text parsing is introduced.

Status, wait and list expose `taskOutcome`. Non-owner, non-admin organization
members retain the safe list metadata projection, but receive `taskOutcome: null`.
Raw rows use the sandbox's existing owner/admin RLS. The Supabase metadata RPC
uses the same redaction.

A new send or steer admission clears both the outcome and reportable prompt ID when activity is
reserved, before provider admission. Its accepted receipt records the new ID.
Reports compare that ID atomically and cannot race a new admitted turn. If
provider admission fails ambiguously the old outcome stays cleared, not
misrepresented as the result of new work. Steer may continue the same prompt or create a replacement turn (for example,
a Codex restart or late native continuation); its receipt may identify an unpollable steer record. Reports therefore resolve
the latest actual prompt from the complete event stream after successful steer,
fencing the lifecycle generation. A missing or non-advancing cursor fails closed.
Internally an empty task_prompt_id marks this successful-steer state; null remains
unreportable for legacy rows and ambiguous send admissions.

Version one deliberately leaves out in-agent credential provisioning,
dashboard UI, outcome filters, notifications, PR/commit verification, automatic
merging, and inference from free-text final messages.
