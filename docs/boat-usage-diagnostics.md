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

## Confirmed admission mismatch and repair

The staging probe on #977 found an instrumented native process and an unclaimed,
unexpired ticket: no native session, turn or completion had been attached. This
localizes the failure before file-flush collection. Inspection of the installed
Boat agent-server driver found its actual Codex `turn/start` shape: optional
`skill` references followed by one text item wrapped in
`<important-instructions-from-user>` (newline after the opening tag). The old
reader accepted only one unwrapped text item and compared its digest with the
raw Armada prompt. Those bytes cannot match the real driver input.

Admission now sends the digest of that exact wire envelope, never the prompt
itself. The native bridge accepts the driver's skill references and compares the
entire framed text, not a guessed substring. Unsupported resume context,
multiple text items, images and ambiguous compound instruction blocks remain
unknown rather than claiming another turn. Raw-prompt quarantine identities are
preserved across upgrades; old admissions cannot be reinterpreted under the new
codec. New admissions omit the legacy digest key so an already-running old
bridge also cannot steal a new ticket by comparing a framed hash with raw text. A deterministic regression drives real admission, the installed bridge,
native RPC notifications, a rollout file and collection with this driver shape.
It failed before the fix with `native_input_unmatched` and now returns 42 input /
7 output tokens. This is a synthetic protocol regression derived from the
installed driver, **not** a claim that staging has already passed the repair.

No environment flag or golden rebuild is required. After the coordinator
releases this server change, validate on a **fresh staging Boat × Codex sandbox**
so the native process starts with the updated bridge. An already running Python
bridge retains its old code even if the executable has been replaced. On the
updated probe, `installedBoatInputEncoding` and live `boatInputEncoding` identify
the new bridge; an unclaimed new admission also has `pendingHasWireDigest` and
`pendingInputEncodingKnown`. All are booleans: no prompt digests are exported.
Run one turn, capture detail and the probe before stopping, and check non-zero
reported tokens in detail and the dashboard. If still unknown, return the API's
`unavailableReason` and new probe JSON on #977 rather than guessing a flush delay.

No `cost` field in detail is expected: pricing is a dashboard-only estimate/API
equivalent at versioned list prices, not a server price or an invoice. This PR
repairs the driver/admission mismatch and adds observability. No migrations or
deployment are performed by this work.
