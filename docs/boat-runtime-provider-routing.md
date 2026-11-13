# Persisted runtime provider routing (#1161)

The registry now recognizes trusted persisted `ProviderTarget.boatRuntime` and
logical `id` hints. Active MCP renewal and historical provider resolvers retain
both when rebuilding a target from SQL. Missing identity or runtime factory
fails closed before resolving native hooks; **never** use native providerFor as
a fallback for a runtime-selected sandbox. Ordinary/Modal targets are unchanged.

HandlerOptions.runtimeProviderFor is an internal provider factory, not a public
configuration input. A producer must reauthorize/load the persisted sandbox and
bind runtime prompt-status/history ports plus a **compute-only** Boat host (no
native model-auth lifecycle hooks). It receives management credentials only in
server memory and retains the existing immutable managementIdentity wrapper.
This slice does not install that producer in serving configuration or expose a
launch flag; selected targets without it refuse rather than running native.

`createRuntimeProvider` is sandbox-bound and explicitly whitelists physical
get/stop/delete plus runtime getPrompt/events. Wrong physical targets are refused.
It does not spread the host object or inherit optional/future native agent ports.
Creation/fork/snapshot/list, prompt/send, steer/interrupt/exec, SSH and quiescence
are explicitly unsupported in this first lane. Read status can use the live
runtime; events should bind the authorized durable reader, including after stop.

The shared API/MCP live mutation gate rejects runtime-selected send/steer/
interrupt/exec/GitHub repair **before** resolving credentials or native providers.
Ordinary stop/delete remain authorized through existing ownership/cleanup paths.
There is no checkpoint, work-preservation or resume guarantee: unsupported
quiescence is not an acknowledgement; callers retain existing failure notes and
must not fabricate a clean checkpoint. Automatic lifecycle/TTL integration still
needs explicit handling before a public opt-in is enabled.

## Coordinator check

Zero Boat starts/model/provider/network calls, no deployment or migration needed:

```sh
bun test packages/mcp-server/test/runtime-provider.test.ts packages/mcp-server/test/mcp-sandbox-provider.test.ts
```

Expected: real SQL active/historical resolvers retain selection; registry calls
only the runtime factory for it and refuses missing configuration/identity;
native target still chooses the old factory. Adapter calls only bound read and
compute cleanup ports, no native agent/optional ports. Shared API/MCP mutation
refusals occur before native credentials/provider resolution. Existing Modal
renewal behavior remains green. Upstream ports are in-memory/disposable SQL.

Next: serving factory/manifest and explicit versioned API/CLI launch, durable
read ports and lifecycle cleanup integration, then the exact ONE-launch check on
#1161. This slice alone is not real Boat inference or a public runtime switch.
