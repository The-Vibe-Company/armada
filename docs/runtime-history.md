# Durable runtime history (#1161)

`packages/mcp-server/src/runtime-history.ts` reads the encrypted journal archive,
not Boat native events or a live runtime connection. It requires the persisted
Boat runtime choice and reuses scoped interior visibility (owner/admin, current
membership and org/private boundaries). It rechecks authorization after decrypting
before returning any history. Stopped sessions remain readable without reviving
compute or validating an expired runtime bearer.

Pages carry `source:"armada-runtime"`. The control logs serializer preserves this
field only when the provider page supplied it; native history responses keep
their existing shape. Combined with an assistant answer from this archive, this
is the source proof the final coordinator smoke can use. Selection alone or an
empty source-labelled page is not evidence of a completed model prompt.

Cursors are opaque `ar1_<logical-sandbox-id>_<raw-sequence>` boundaries. Native or
cross-sandbox cursors are refused, never passed to a host API. Forward/backward,
raw-entry limit, byte budgeting and authoritative snapshot coalescing use the
existing shared page builder. Cursor anchors remain raw even when coalesced or
conversation-filtered. Filtering occurs after bounding: an empty matching page
can advance its cursor, and its byte budget can be conservative because inspected
unrelated entries also counted. No unbounded decrypt-and-scan loop is introduced.

Corrupt ciphertext/JSON produces fixed diagnostics, not archive/ciphertext text.
The service performs no provider/model/network operation and needs no new schema.
This slice does not yet bind persisted-mode provider routing or expose a launch
switch; existing native/Modal behavior is unchanged. Live prompt status and
stop/resume/cleanup integration remain separate from this durable read service.

## Coordinator check

Zero Boat starts, deployment or migrations required:

```sh
bun test packages/mcp-server/test/runtime-events.test.ts
bun test packages/mcp-server/test/control.test.ts --test-name-pattern 'logs tail|logs follow'
```

Expected: events ingested through the actual fenced route survive stop and read
back with source/cursor/byte/coalescing semantics; foreign/native targets and
wrong cursors are refused; revoked membership cannot receive a decrypted page;
corrupt data fails safely. Control serialization preserves runtime source but
never adds it to native pages. Tests use disposable local SQL and in-memory
provider ports, no model calls or native host runner.

The exact ONE-launch coordinator check will follow on #1161 when default-off
API/CLI selection and complete startup/read/cleanup routing are wired. Rebuild
and publish matching runtime/harness artifacts before enabling that path.
