# Claude Code runtime upgrade (issue #870)

## Pin and compatibility

Managed runtime: Claude Code **2.1.322**, Claude Agent SDK **0.3.322**.
These were npm's latest non-prerelease releases when checked on 2026-11-10;
the older npm `stable` channel was 2.1.311 (below Fable's minimum).
The [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
explicitly declares parity with Code 2.1.322.
The [Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
introduces `claude-fable-5-2` in 2.1.321. This upgrade precedes the catalogue PR #866.

Compared 2.1.319 → 2.1.322 and SDK 0.3.319 → 0.3.322:
- The SDK's `core.d.ts` and `agentSdkTypes.d.ts` are unchanged. Stream-json
  assistant/tool/partial/result shapes used by our adapter remain compatible.
- Native help still exposes stream-json input/output, partial messages,
  `--resume`, `--mcp-config`, `--strict-mcp-config`, `--model` and permission
  bypass flags. Existing real-SDK/local-JSONL-peer tests exercise steering,
  merged results, interrupt, private MCP configuration and session resume.
- SDK 0.3.321 improves resume initialization ordering; WarmQuery, dynamic
  setMcpServers and hook fixes do not require changes to our per-turn query path.
  Auto-mode queued subagent reports may have empty zero-turn results; Armada
  uses bypassPermissions, not auto mode. No adapter rewrite is required.
- Code 2.1.321 fixes MCP OAuth redirect secret leakage and Bash permission
  checks; do not restore the old behaviour. Armada's strict private MCP config
  and explicit permission mode remain unchanged.
- The `fable` alias now resolves to Fable 5.2 (saved Fable 5.1 selections can
  migrate subject to account policy). Explicit full model IDs remain supported.
  Armada's explicit default `claude-opus-5-5` is unchanged. 2.1.322 adds Vertex
  fast-mode support; Armada's fast-model policy is unchanged.

## Build/distribution inventory

The exact npm pins and integrity hashes are in `packages/agent-runtime/package.json`
and `bun.lock`. Native build and portable preparation emit matching manifests;
native validation checks actual executable versions. Modal artifact loading and
server-embedded manifest guards use the same pins. Modal's image installs those
exact packages; runner SHA-256 is computed from the rebuilt bundle, not a static
checksum to hand-edit. The server must be rebuilt with that artifact.

The shared golden recipe upgrades an older preinstalled Claude executable to
2.1.322 at `/usr/local/bin/claude` using `sudo -n npm install --global --prefix /usr/local`;
it verifies that absolute executable and fails the build on a mismatch. A newer
image version is deliberately downgraded to the exact validated pin, rather than
shadowed by a different PATH installation. Modal's base image is
already pinned to it. Repo-specific setup/init commands can still override it:
remove/update any old Claude install in your saved config or setup script.

## Operator action (not performed by this PR)

After releasing the rebuilt server/runtime, refresh **every provider-specific
golden used for Claude launches**, including private and organization goldens.
Existing snapshots and already-running sandboxes are not upgraded by a release.
Keep each golden's full repo/branch/init configuration (and original setup file,
if used); update any explicit old tool pin. Rebuild, do not just re-snapshot the
old master. For example, with the existing configuration saved as `golden.json`:

```sh
armada golden update <name> --provider boat --org <org> --config golden.json
armada golden update <name> --provider modal --org <org> --config golden.json
# Add --setup <original-setup-file> when the original build used one.
armada golden build-status <job-id>
```

Run only the command for each provider actually hosting that golden. Boat and
Modal snapshots are separate: updating one does not update the other. Boat gets
the executable from the shared recipe; Modal also gets the rebuilt managed
runner and pinned image. Use the correct owner's session for private goldens.
Wait for each build to succeed; launch fresh sandboxes for validation.

After #866 is merged, on each refreshed provider golden:

```sh
armada launch <name> --provider <boat-or-modal> --agent claude --model claude-fable-5-2 "Which model are you running? Report your exact model ID."
armada launch <name> --provider <boat-or-modal> --agent claude --model claude-opus-5-5 "Which model are you running? Report your exact model ID."
```

Inspect turn/model metadata as well as the response. Test with an entitled account;
an account without access must fail normally, without model substitution.
No authenticated production/model call is part of local build validation.
