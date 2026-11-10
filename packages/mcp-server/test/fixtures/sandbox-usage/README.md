# Usage stream provenance

`codex-exec-completed.json` is the unmodified terminal usage frame from a real,
successful local Codex invocation on 2026-11-10:

```sh
codex exec --skip-git-repo-check --json 'Reply only OK. Do not use tools.'
```

Only the terminal frame is retained. It contains no prompt, response, identifiers,
paths or credentials. This is the native **exec** stream, not an app-server
notification and not a Boat event envelope. It establishes the snake-case token
fields, including cache-write and reasoning output counts; it does not prove
that either provider forwards that frame.

The local Claude invocation returned "Not logged in" and an error result with
empty `modelUsage`; it is not successful Claude usage evidence and is not
included. Boat event access returned HTTP 401. Successful Claude and real Boat
envelope recordings are still required before claiming issue #874 is fixed.
