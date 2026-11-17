# Sandbox outputs

Write deliverables as regular files directly inside `/workspace/outputs` (create it if absent). This fixed directory is the declaration; no API accepts arbitrary filesystem paths. Subdirectories, symlinks, hard links and special files are excluded. Python 3 is required in the sandbox. The collector opens the directory and files without following symlinks.

Supported paths are native Boat and Modal sandboxes. The server samples running workspaces approximately every 30 seconds and takes a final snapshot on every Armada stop (user, managed-child, idle, expiry and agent-finished stops) after the agent is quiesced and before the provider stop is dispatched, so a deliverable written just before stop remains downloadable afterwards. Each snapshot has at most 32 files, 32 KiB per file and 32 KiB total (below the exec transport budget, including base64 and metadata). Use short filenames without control characters. Oversized files are skipped; provider truncation or collector failure retains the previous snapshot and never blocks the stop. Docker and enrolled-runtime sandboxes (Boat runtime, Modal dial-out) are not supported: they refuse server exec. A stop the provider performs on its own, outside Armada, exposes only the last successful sample. Collection never resumes stopped compute. Application-secret exposed (tainted) sandboxes are never collected, their existing snapshots are purged when taint is recorded, and their outputs routes return 404, matching the exec and work-recovery refusal.

Authenticated owner/admin callers can use:

- `GET /api/v1/sandboxes/{id}/outputs`: declared directory and file metadata (`name`, `size`, `sha256`, `updatedAt`).
- `GET /api/v1/sandboxes/{id}/outputs/{encodedName}`: attachment bytes, content type, length, nosniff and private/no-store headers.

Collected snapshots are encrypted using `ARMADA_ENCRYPTION_KEY` and remain readable after stop without contacting the provider. Deleted sandboxes are inaccessible. A new successful snapshot replaces the previous file set; files removed from the directory disappear on the next successful sample. The bounded last snapshot is retained until the sandbox row is purged.

Each new or changed file emits `sandbox.output.available` through the existing signed webhook outbox, atomically with persistence. Payloads include the sandbox/org IDs, external reference and output name, size and SHA-256; no document bytes. Unchanged files do not emit duplicate events. Webhook receivers should fetch using their existing Armada token and handle ordinary at-least-once delivery.

Design decision: provider exec was the only file egress path, and it is revoked once a stop is dispatched. A server-owned fixed collector, run periodically and once more inside the shared pre-stop hook (`preserveBeforeStop`), plus encrypted snapshots provides bounded file access and retained downloads without granting clients arbitrary filesystem reads or waking stopped machines. Outputs are opt-in by writing to the declared directory; do not put credentials there.
