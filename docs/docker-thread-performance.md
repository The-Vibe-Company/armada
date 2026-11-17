# Docker thread read path (#2543)

Baseline: main after #2542, measured offline with
`bun packages/mcp-server/benchmarks/docker-thread.ts`.
The fixture has 50,000 encrypted 1 KiB output events. It executes real Docker
controls, pagination and AES decryption against a query fixture. The injected
clock charges one logical work unit per SQL call; these are work counts, **not
milliseconds or production latency**. No provider, network or daemon is used.

| Operation | SQL calls | Decryptions |
| --- | ---: | ---: |
| Thread open (status + first 100 events) | 26 | 1102 |
| Status | 11 | 501 |
| Logs page (100 events) | 15 | 601 |
| Live tail (status + empty forward page) | 26 | 1002 |

Fixture scope: no queued admissions or command receipts. Queued prompts and
receipts add work; this is a reproducible busy-output baseline, not a worst case.
The benchmark counts decrypted event rows (excluding the lookahead) and launch
manifests. Ciphertext reuse reduces fixture setup cost; it does not cache reads.

## Every hop

1. The browser requests the sandbox page/RSC. `sandboxes/[id]/page.tsx`
   reads the user-JWT Supabase sandbox, memberships and member directory. Docker
   additionally reads launch options, credential metadata, host labels and account
   choices (when eligible). Cloud instead reads golden/connections metadata.
2. `SandboxAttention` can independently read logs for attention details. The chat
   mounts with an empty cursor and fetches `/api/sandboxes/:id/events`.
3. That route authenticates the viewer and reads the sandbox via Supabase. It
   starts gateway `status` and `logs` in parallel over authenticated MCP. The
   gateway negotiates MCP initialization/session as needed; SSE response parsing
   here is RPC framing, not a browser event subscription.
4. Docker controls authorize owner/admin membership, read queue/admission state,
   and read/decrypt retained SQL runtime events. Status reads at most 500 events
   for the latest turn after #2542; explicit historical prompt lookup can still
   read 100 pages. Logs reads one forward page (default 100) and then runs status
   internally for settlement/failure/queued-prompt metadata. This repeats status
   work alongside the route's explicit status call.
5. Browser immediately follows advancing historical cursors (`setTimeout(0)`),
   then waits 2,000 ms **after each response** for active sandboxes. Inactive
   threads stop polling after history drains; retries back off. Status/usage
   changes can request an RSC refresh, repeating page metadata reads.
6. Docker read requests enqueue no daemon job and make no live runtime RPC.
   Daemon `main.ts` sleeps 20 seconds after each tick; this adds up to roughly
   20 seconds plus tick duration for host jobs (bootstrap/cleanup), not journal
   reads. Runtime events POST directly to `/api/runtime/events` through dialout;
   the host daemon is not the event courier. `agent-runtime/src/main.ts` flushes
   the outbox every 1,000 ms; each flush drains batches of up to 100 events /
   1 MiB until caught up. Failed flushes retry on the next tick. Normal event
   visibility therefore includes up to one second before ingest, independently
   of the browser polling interval.

Modal runtime and experimental Boat runtime use retained runtime history too;
Boat native uses provider events. All share the same browser cursor/poll loop.
The benchmark isolates the Docker control portion, excluding page metadata,
HTTP/MCP negotiation, concurrent SQL contention and network RTT. Production
end-to-end measurements require the coordinator; no production was accessed.

## Relay decision

The authenticated outbound runtime channel already relays commands behind NAT:
WSS `/api/runtime/channel`, epoch-bound session, serial acknowledged commands;
on disconnect it permanently falls back to HTTPS long polling for that process.
Empty polls hold up to 20 seconds; the client waits one second after an empty
reply. Events use authenticated HTTPS ingest and durable encrypted journal ACKs,
independently of command polling. No new host port or credential is needed.

These counts identify repeated server work, not transport delay. First reduce
that work. Keep cursor pagination and independent status error handling. A future
browser push path would need a viewer-authorized subscription, reconnect cursor,
revocation and bounded backpressure, with existing polling as fallback. The runtime
WSS is machine-scoped and must not be exposed to browsers. No evidence here
justifies a new relay service, inbound port, or credential; those require an owner
decision and production timing separating ingest from browser observation.

## First cheap fix

Logs now skips the repository launch-manifest query/decryption used only by the
public status response. It retains its fresh status/settlement calculation and
all access checks. Public status still returns repositoryDir. The repeated
journal reads remain: sharing across separately authenticated MCP requests would
need explicit snapshot/freshness semantics; no global decrypted cache is added.

| Operation | Before SQL / decryptions | After SQL / decryptions |
| --- | ---: | ---: |
| Thread open | 26 / 1102 | 25 / 1101 |
| Status | 11 / 501 | 11 / 501 |
| Logs page | 15 / 601 | 14 / 600 |
| Live tail | 26 / 1002 | 25 / 1001 |

This is a small work reduction, not evidence the owner's production delay is
resolved. Dominant remaining work is the two status journal reads per browser
poll (500 decryptions each), plus the forward page. Browser observation also
adds 0–2 seconds plus response time. Ask the coordinator to time page metadata,
MCP negotiation, SQL and ingest-to-browser delay after release before changing
transport. The benchmark intentionally does not extrapolate network latency.
