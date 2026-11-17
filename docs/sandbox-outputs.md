# Sandbox outputs

Write deliverables as regular files directly inside `/workspace/outputs` (create it if absent). This fixed directory is the declaration; no API accepts arbitrary filesystem paths. Subdirectories, symlinks, hard links and special files are excluded. Use short filenames without control characters.

Each snapshot has at most 32 files, 32 KiB per file and 32 KiB total (below the provider transport budget, including base64 and metadata). Oversized files are skipped. A failed or out-of-bounds read keeps the previous snapshot; it never blocks a stop or the shared worker.

## How outputs are read

Supported providers are Boat and Modal, both native and enrolled-runtime sandboxes (Boat runtime, Modal dial-out). Docker sandboxes are not supported. The server reads the directory through `Provider.readOutputs`: a fixed, bounded provider read. It never runs caller commands, never goes through the agent runtime and never starts or resumes compute.

- **Running sandboxes** are sampled approximately every 30 seconds. A fixed collector reads the live disk without following symlinks; it needs Python 3 in the guest. Boat runs it through its command API. Modal runs it on the physical container, so enrolled runtimes that refuse server exec are covered too.
- **Armada stops** (user, managed-child, idle, expiry, agent-finished and credential-migration stops) take a final live snapshot before provider stop is dispatched, after the agent is quiesced where work preservation runs.
- **Boat retained disks**: every Boat stop saves the disk first, including TTL or provider-initiated stops and stops Armada only observes later. After each stop the worker reads the declared directory once from the sandbox's latest completed disk snapshot, without contacting the machine. Files written or changed after the last sample are therefore downloadable after any stop. An incomplete (truncated) snapshot listing leaves the previous snapshot in place.
- **Modal retained workspaces** are recovery images that cannot be read without compute. Modal only retains a workspace through Armada's own stop, so the final pre-stop snapshot is what the stopped sandbox exposes. If that capture fails or its shared pre-stop budget is exhausted, the last successful sample remains.

Application-secret exposed (tainted) sandboxes are never read. Their existing snapshots are purged when taint is recorded, and their outputs routes return 404, matching the exec and work-recovery refusal.

## API

Authenticated owner/admin callers can use:

- `GET /api/v1/sandboxes/{id}/outputs`: declared directory and file metadata (`name`, `size`, `sha256`, `updatedAt`).
- `GET /api/v1/sandboxes/{id}/outputs/{encodedName}`: attachment bytes, content type, length, nosniff and private/no-store headers.

Collected snapshots are encrypted using `ARMADA_ENCRYPTION_KEY` and stay readable after stop without contacting the provider. Deleted sandboxes are inaccessible. A new successful snapshot replaces the previous file set; files removed from the directory disappear on the next successful read. The bounded last snapshot is kept until the sandbox row is purged.

Each new or changed file emits `sandbox.output.available` through the existing signed webhook outbox, in the same transaction as persistence. Payloads include the sandbox/org IDs, external reference and output name, size and SHA-256; no document bytes. Unchanged files do not emit duplicate events. Webhook receivers should fetch using their existing Armada token and handle ordinary at-least-once delivery.

## Design decision

Provider exec was the only file egress path, and it is gone once compute stops. Periodic snapshots alone miss files written after the last sample, so the retained-workspace contract is met at the provider boundary. Boat reads the retained disk snapshot it already keeps for every stop. Modal, whose retained image needs compute to read, captures before Armada's stop. The server stores encrypted bounded snapshots, which gives retained downloads without arbitrary filesystem reads or waking stopped machines. Outputs are opt-in by writing to the declared directory; do not put credentials there.

Staging must still confirm the Boat snapshot path layout (`workspace/outputs/...` relative to the snapshot root) and Python 3 availability in goldens; this repository's tests use provider stand-ins.
