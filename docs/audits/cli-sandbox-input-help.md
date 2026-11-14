# Sandbox input help (#979)

Focused help now covers send, steer and exec with either flag before login/I/O.
Exact boundaries only; prompts and command payloads retain existing parsing.

```sh
armada send SANDBOX_UUID --org ORG_UUID -- "Review the changes"
armada steer SANDBOX_UUID --org ORG_UUID -- "Focus on the failing test"
armada exec SANDBOX_UUID --org ORG_UUID -- "git status --short"
```

Place Armada options before the terminator to preserve option-like payloads.
Send starts a new instruction; steer redirects a running turn and is refused
without one. Inspect steer delivery to distinguish native join from restart.
Retained stopped sandboxes can wake on send. Native turn model/effort can
override launch choices; runtime model/effort remain pinned. Reuse identical
input/request ID after uncertain runtime delivery, but native providers do not
deduplicate by that ID. Inspect state before replaying.

Exec runs a shell command, not an agent instruction, default cwd /home/user.
Its timeout is integer seconds 1–600, default 120. Inspect exitCode/timedOut and
truncation in JSON; CLI transport success does not prove command success.
All three retain server authorization and JSON output.

Offline run.ts audit: 12 long/short-help probes in no-session/fake-token modes
show broad root help before and focused guidance after, zero requests.
No prompt, steering or shell command is sent. This help-only slice uses the
issue's live-audit exemption; no staging/provider/TTY evidence or operation,
permission, exit-code or output changes are claimed.
