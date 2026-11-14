# Stop versus interrupt help (#979)

Focused help now covers stop and interrupt with either flag before login/I/O.
Exact boundaries only; IDs, conversation selectors and other operation arguments
retain their existing parsers.

```sh
armada stop SANDBOX_UUID --org ORG_UUID --json
armada interrupt SANDBOX_UUID --org ORG_UUID --json
armada interrupt SANDBOX_UUID --conversation CONVERSATION_ID --org ORG_UUID
```

Interrupt stops a running turn in one conversation, or all, leaving the sandbox
up for the next send. Provider/harness support and server authorization apply.
Stop instead shuts down the machine. Modal disk retention depends on checkpoint
success; fallback termination cannot resume. Inspect returned status/preservation
information rather than assuming disk retention. For an uncertain stop, inspect
status/list before retrying. Permanent deletion is the separate rm action.
Both operations always emit JSON.

Offline run.ts audit: eight long/short-help probes in no-session/fake-token modes
show broad root help before and focused guidance after, zero requests.
No interruption or stop occurs. This help-only slice uses the issue's audit
exemption; no staging/provider/TTY evidence or operation, permission or output
changes are claimed.
