# Boat session usage triage (#977)

Run from the branch containing `scripts/diagnostics/boat-usage-probe.py`, using
an already authenticated **staging** Armada CLI/session. Launch one Boat × Codex
turn as usual, wait until it finishes, and run this **before stopping**:

```bash
PROBE=$(python3 -c 'import pathlib,shlex; print("python3 -I -c " + shlex.quote(pathlib.Path("scripts/diagnostics/boat-usage-probe.py").read_text()))')
armada exec ACTIVE_SANDBOX_UUID -- "$PROBE"
armada detail ACTIVE_SANDBOX_UUID --json
```

Use the existing staging URL/organization configuration; do not accidentally run
against a production resource. Do not send a second turn, rebuild the golden, or
stop/restart the first sandbox before capturing the JSON: those actions change
the evidence. The probe itself does not run inference or modify guest state.
`armada exec` still runs its normal preparation/native-auth hooks, which may update
an entrypoint or quiesce a managed native process before the script executes.
Therefore process/installed-wrapper facts describe probe time, not necessarily
the preceding turn. An empty native list alone never proves the cause. Persistent
admission/session/turn/terminal flags are the primary historical stage evidence. It outputs
only bounded metadata booleans/counts/modes, never prompts, environments, argv,
native/session identifiers, native paths, records, or credential values. Return its JSON on #977.

## Interpretation, not assumptions

- There is no usage-enable environment flag. Codex pre-prompt installation and
  admission are attempted automatically. Golden age alone does not establish a
  need to rebuild: installation updates the executable, not an already running
  app-server's memory or a launcher that bypasses that entrypoint.
- Installed usage hook present but not observed in the live process ancestry,
  with an unclaimed pending ticket: investigate warm/pre-existing processes or
  entrypoint bypass before waiting for a file flush. `inspectionComplete:false`
  or unknown wrapper format means the probe cannot establish absence.
- Global options before `app-server` are a diagnostic fact, not proof that the
  collector was bypassed. Never paste raw argv to identify them.
- A mapped ticket with no session/turn means native attribution was not observed;
  a session/turn with no terminal means native completion was not observed.
  A terminal ticket with no final snapshot moves investigation to file/schema,
  baseline or flush. These are stage distinctions, not a diagnosis of a cause.
- Mode values other than owner-private directories may explain a refused helper;
  do not blindly chmod unrelated files or remove locks/quarantines. Missing state
  is not zero token usage. Truncation/read-failure flags mean incomplete evidence.
- API diagnostics added by this PR appear on unmeasured `usage.turns[]` entries as
  `unavailableReason: {code, message}`. They are closed, sanitized stage reasons,
  not raw native errors. Detailed reasons collected before stopping are retained.
  The probe can run on current staging before this API change is deployed.

No `cost` field in detail is expected: pricing is a dashboard-only estimate/API
equivalent at versioned list prices, not a server price or an invoice. This PR
adds observability, not a guessed golden rebuild or a fix for an unverified
staging cause. No migrations or deployment are performed by this work.
