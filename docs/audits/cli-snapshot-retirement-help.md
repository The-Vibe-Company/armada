# Snapshot retirement discovery (#979)

Focused long/short help now covers snapshot retirement dry-run and reconcile,
including legacy golden aliases, before login/I/O. Exact boundaries only:
record IDs and input-file arguments retain existing operation parsing.

```sh
armada snapshot retirement dry-run SNAPSHOT_UUID --org ORG_UUID --limit 20
armada snapshot retirement reconcile SNAPSHOT_UUID --org ORG_UUID --file reviewed.json
```

Use the snapshot record UUID, not a sandbox or provider artifact ID.
Dry-run reviews bounded historical candidates without provider mutation.
Review its output before reconciling: the input JSON must contain 1–50 valid
receipts in results. Supply a file or omit file for stdin; file '-' is not
this command's stdin spelling. Limit accepts 1–50, default 20; output is JSON.

Reconciliation rechecks authority/history/references and queues eligible
retirement work; its response is not proof of provider deletion.
Server owner/admin authorization remains required.

Offline run.ts audit: 16 help probes across two actions, two command spellings,
both flags and no-session/fake-token modes; all fail before and pass after,
zero requests/input reads. No history or retirement work is touched.
The issue's help-only exemption applies; no staging/provider/TTY evidence
or operation, permission or output changes are claimed.
