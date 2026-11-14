# Resource-advice discovery (#979)

Advice now has focused long/short help before login/I/O instead of broad root
help. Exact boundaries only; sandbox IDs and option values retain their parsers.

```sh
armada advice SANDBOX_UUID --org ORG_UUID
armada advice SANDBOX_UUID --org ORG_UUID --json
```

The authenticated operation collects one bounded sample and considers up to the
last ten comparable sessions. Missing/partial evidence can produce no
recommendation; unknowns are not measured headroom. Recommendations concern
future launches, never automatic resizing or changing defaults.
Human output summarizes supported advice or a no-recommendation reason; JSON
exposes the full evidence response. Server authorization remains unchanged.

Offline run.ts audit: four no-session/fake-token help probes show broad root
help before and focused guidance after, zero requests. No sampling, provider or
sizing operation occurs. This help-only slice uses the issue's audit exemption;
no staging/provider/TTY evidence or operation, permission or output changes
are claimed.
