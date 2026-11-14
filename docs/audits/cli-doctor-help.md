# Doctor discovery (#979)

Doctor's help now shows a focused page instead of the broad root command list.
Both flags run before authentication or I/O, without performing diagnostics.

```sh
armada doctor --help
armada doctor -h
armada doctor --org ORG_UUID --json
```

The operation inspects setup metadata and gives check statuses/next steps.
It uses explicit organization over a saved selection and can infer a sole
organization. Human output is tabular; JSON contains a checks array.
Any failed check makes the command exit 1; otherwise it exits 0.
Warnings/unknowns must not be interpreted as positive validation.
Metadata checks are not full provider lifecycle or model-request evidence.

Offline run.ts audit: four no-session/fake-token long/short-help probes.
Before they show broad root help; after they show focused help, zero requests.
The owning regression checks focused usage before authenticated I/O and fails
on the original source. No diagnostics, provider or staging calls are made.
This help-only slice uses the issue's audit exemption; operation behavior,
exit codes and JSON output remain unchanged.
