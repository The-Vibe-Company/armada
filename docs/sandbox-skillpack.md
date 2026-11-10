## Design before implementation
Closes #867.

Launch-first slice, as explicitly allowed by the issue. Investigated Armada #839's bootstrap, launch/store/API/MCP/child paths and read-only Skillpack runtime/internal/cli/install.go and public.go. Reuse the existing exact public catalog pin pattern, native install command and lock receipt validation in one shared server-only core module; the orchestrator bootstrap calls that same module. Repeatable CLI --skill becomes skills[] across API, MCP and delegated child selection. Install sequentially in the selected repository (or golden root) before first turn; persist verified receipts on sandbox status/detail. Invalid refs fail before allocation; install/provenance failures sanitize diagnostics and use existing failed-launch cleanup.

Goldens must already provide native skillpack on PATH, as #839 requires. No downloaded script, credential path, private skills or custom origins. Golden defaults/official pinned-checksummed CLI installation are a separate follow-up (linked below). No golden config field is added in this slice, so existing config validation remains unchanged.

## Validation / deployed check
Pending implementation and independent review.
Coordinator deployed check: launch a public exact pin with a compatible Skillpack-equipped golden on Boat and Modal, confirm status receipt and first-turn discovery; unavailable pins must leave a failed/stopped sandbox with no first turn. No deployment or migration application performed here.
