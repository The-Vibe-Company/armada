# Golden scan provider contract follow-up

Boat SDK 1.13.0's CommandRequest documents an integer timeout from 1 through
600 seconds. Its generated serializer does not validate this constraint.
The public OpenAPI agrees:
https://docs.boat.dev/api/reference/agent/execute-sandbox-command

The scan requested 900 seconds. This violates the request contract before
execution; the scan now requests the maximum accepted 600 seconds. The scan
script, filesystem roots, binary matching and git-object coverage are unchanged.
Timeouts still fail closed and cannot produce a snapshot.

## CLI transport: unresolved production deadline

The published CLI's golden create/update calls explicitly use a 600-second
AbortSignal (not the API client's ordinary 10-second default). The dashboard
proxy uses a 660-second AbortSignal and declares maxDuration=800. These do not
explain a client transport rejection after 270246ms. That elapsed time alone
does not establish which runtime, gateway or connection imposed the deadline.

For an orchestrator-approved candidate test, use ARMADA_URL pointing directly
to the approved control API origin, bypassing the dashboard proxy. This still
authenticates only to Armada and requires no provider or database credentials.
The direct endpoint remains subject to its own infrastructure deadlines.
Do not automatically retry a timed-out create: a disconnected request may still
be building. Inspect build status first. A durable asynchronous build/status API
would remove dependence on a single long HTTP request; it is not implemented here.

No production request, rebuild, migration, publication or release workflow was
run for this investigation. The candidate bundle is not proof that the
270-second failure is fixed.

## Tested CLI candidate mitigation

Bun also documents a separate fetch idle timer, independent of AbortSignal:
https://bun.com/reference/globals/BunFetchRequestInit/timeout

The candidate sends timeout:false on authenticated API requests (including the
401 replay), leaving the explicit AbortSignal in charge. A client-boundary test
checks that the long-operation signal and this option survive together.
This removes a documented competing timer on runtimes supporting the extension;
it does not prove which timer caused the observed 270246ms failure. The default
five-minute idle timer is not an exact match for that observation. The proxy and
platform limits still apply, and direct-origin validation remains required.
