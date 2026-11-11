# Stored Modal reads and server phase timing (#978)

## Evidence / root cause

Coordinator #1013 after run (main 4a0a3309, same macOS machine/network,
20 samples, smoke-modal): detail p50/p95 1524/1775 ms, logs 996/1123 ms,
golden/list 192/236 ms, sandbox/list 218/248 ms, prompt admission 3087 ms.
Untouched lists also improved, so the earlier gain cannot be cleanly attributed
to that patch.

The remaining paths still resolved a live Modal provider per request:
composition performed an App lookup; events performed another App lookup;
detail polled the container and queried the runner for prompt state, and could
collect native usage. Removing only the duplicate inner App lookup in #1013
did not remove those network dependencies.

## Change and consistency

Modal `sandbox/detail`/`sandbox/status` and logs now use a server-selected stored
observation adapter, including dashboard MCP status/logs. Composition/get/events
skip live App calls in this adapter; get reads the stored machine, getPrompt
reads one latest prompt transition with a scoped SQL query, not a transcript replay.
Fresh membership, immutable source scope and
management provenance checks remain, including deleted-machine refusals.
Provider credential resolution is still fresh/local; nothing caches authorization.
No read acquires an activity/lifecycle lease, queries the native runner, polls
compute, collects native usage or publishes lifecycle/telemetry observations.
The production stored adapter refuses mutation methods.

Physical state is eventually consistent: the existing lifecycle worker observes
machines and persists stop/failure state on its scheduled reconciliation cycle
(eligible rows are scheduled a minute after observation; backlog/errors can delay
that). Reads do not start another refresh or reschedule the worker. Prompt state
comes from authenticated asynchronous event ingestion. A newly admitted active
turn without ingested evidence is conservatively queued, never called finished.
Native usage fields are retained observations, not a fresh sampler; live wait/
stop/admission paths retain their existing collection and physical checks.

Boat reads, wait, send, report, exec, stop, resume and lifecycle management keep
live providers. No migration or new worker/service. Orchestrators are excluded.

## Server-Timing / repeatable after run

Successful authenticated control API replies include fixed-name `Server-Timing`
durations (milliseconds); no token, SQL text, ID, URL, prompt or header value is
copied into metric names. The dashboard control proxy preserves this header from
its fixed trusted Armada upstream. Unauthenticated/error replies do not expose timings.
The unchanged client wall/payload measurements are still recorded by:

```sh
bun install --frozen-lockfile
# Securely export ARMADA_TOKEN, STAGING_URL and STAGING_ORG as before.
python3 scripts/perf/staging.py --samples 20 --golden smoke-modal > /tmp/armada-stored-reads-after.json
```

Schema 2 adds per-read `serverMs` p50/p95 and sample counts, and per-lifecycle
observation `serverMs`. Missing headers/phases are absent, not zero. The script
prints only allowlisted numeric phase names/durations, never arbitrary headers.
Run on the same macOS host/network/org/fixture and post the deployed revision
and full JSON on #978. Confirm cleanup.deleted=true. No after numbers or
user-facing speedup are claimed before that run; coordinator owns post-merge
deployment and measurement, as in the previous PR.

Phases:
- `auth`: bearer and membership resolution.
- `dispatch`: complete API dispatch, including all nested work below.
- `sandbox_read`: authorized sandbox read for status.
- `stored_provider` / `provider`: stored observation setup vs live provider setup.
- `state`: status projection (or follow-logs stored state lookup).
- `logs_target`: authorized log target plus provider setup.
- `events` / `prompt`: page reads and follow prompt projection.
- `send_credentials`, `send_state`, `send_turn_auth`, `send_submit`: credential
  validation, live machine observation, native-turn authorization and native
  submission (including its existing lifecycle/MCP hooks).

Nested phases overlap; do not sum them. SQL trip counts and individual database
query timings are not claimed. HTTP auth/setup and native admission are now
distinguishable from time spent in the network and client startup.

## Prompt admission investigation

Send still requires fresh live physical state, credential ownership and fenced
activity/native admission. Its provider setup, machine read and native submit
are now separately timed. Inspection found native submission may run two
healthy-admission phases around `beforePrompt` MCP setup, which itself has
independent authorization/leases. Those are incarnation safety fences, not
removed speculatively in a read-performance patch. The next coordinator run's
`prompt_admission.serverMs` identifies which phase dominates before the next
small admission PR. No admission safety checks were weakened.

## Local evidence

Tests prove stored composition succeeds with App, physical and runner RPCs
unavailable, including while another lifecycle writer holds the lease; live
membership removal still refuses the next read. Existing source/deleted tests
remain. A stored terminal status projection does not publish state or collect
usage; its regression fails on the original live-read code. The HTTP boundary
checks authorized stored-provider selection, a bounded SQL-trip budget for prompt
lookup across a multi-page history, and fixed secret-free timing
headers. No wall-clock thresholds or network-dependent tests were added.
