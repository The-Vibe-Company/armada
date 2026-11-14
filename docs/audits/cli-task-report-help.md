# Task-report discovery (#979)

Report now has focused long/short help before login/I/O instead of broad root
help. Exact boundaries only: sandbox/prompt IDs, states and reason values keep
their existing parsers.

```sh
armada report SANDBOX_UUID blocked --prompt-id PROMPT_ID --reason "Need owner input"
armada report SANDBOX_UUID ready --prompt-id PROMPT_ID --pr-number 123
```

Use the latest finished prompt ID after wait, not an earlier turn. Reporting is
restricted to sandbox owner/current organization admin. Blocked requires a
nonempty reason up to 1000 characters; ready accepts optional PR number, URL
and head SHA. Output is always JSON.
A new send clears the report. Message text is not implicitly an outcome, and
a ready report does not independently verify CI or merge a PR.

Offline run.ts audit: four no-session/fake-token help probes show broad root
help before and focused guidance after, zero requests. No outcome is recorded.
This help-only slice uses the issue's audit exemption and adds no orchestration
capability or changes to operations, permissions or JSON schemas.
No staging/provider/TTY evidence is claimed.
