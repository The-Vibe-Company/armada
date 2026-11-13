# Docker workspace preparation from a golden file

Normal Docker launch can consume the existing versionable golden JSON format:

```json
{
  "repos": [
    {"url":"https://github.com/example/project.git","branch":"main","dir":"project"}
  ],
  "init": ["cd /home/user/project && bun install"]
}
```

Use `armada launch ... --provider docker --host UUID --config armada.golden.json`.
The same file may be used to build a Boat/Modal golden through their existing
commands; snapshots themselves remain provider-specific. `--config` cannot be
mixed with `--repo`/`--init` overrides. The path stays local to the client; only
validated repos/init data enters the normal API (`repos` plus optional `init`).
No credentials belong in the file, init commands or command-line arguments.

The server applies the shared golden parser's repository, branch, directory,
init-count/length and secret-assignment restrictions. Init requires repository
configuration. Repositories are checked out with the owner's current GitHub
access, then init runs sequentially in `/home/user` through the existing enrolled
runtime workspace operation and bounded process ownership, before skills/MCP
preparation and the first prompt. Ordinary workspace exec does not inherit
model or application-secret environments. Runtime `workspaceVersion:1` is
required; missing support refuses safely, with no native/provider fallback.

Each init step uses the shared epoch/phase/index durable command identity. An
exact launch replay does not re-run acknowledged init; changed config conflicts
with the admitted request ID. Failed/timed-out init does not admit the first
prompt. Existing normal-send launch-publication fencing remains in force.
Init is initial-allocation preparation, not a resume script.

This is **not yet the build-once image builder/publication feature**. Docker
still allocates from its selected plain image and prepares a fresh workspace;
`capabilities.goldens` stays false. Host-local image building, secret-free
publication and environment discovery remain the next #1464 work. No Docker
alias for Boat/Modal snapshot IDs is introduced.

## Coordinator's single real-host check

On host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`, prepare a dedicated non-secret
golden config with an authorized GitHub repository and this init proof step:

```json
{
  "repos": [{"url":"https://github.com/The-Vibe-Company/armada.git","branch":"main","dir":"armada"}],
  "init": ["printf '%s' 'CONFIG_INIT_OK' > /home/user/.armada-environment-proof"]
}
```

Set `ARMADA_DOCKER_INIT_EXPECTED=CONFIG_INIT_OK` in the coordinator environment;
keep ARMADA_TOKEN environment-only. With existing server/org/account/image/SSH
inputs and the local config path in ARMADA_DOCKER_GOLDEN_CONFIG:

```sh
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_URL" --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --ssh "$ARMADA_DOCKER_SSH" --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 \
  --image "$ARMADA_DOCKER_IMAGE" --config "$ARMADA_DOCKER_GOLDEN_CONFIG" \
  --normal-lifecycle
```

One allocation. Require archived successful init workspace-step evidence for
all steps, successful Git log output, exact proof-file tool output (not an
assistant claim), and proof-file persistence/retained memory through follow-up
and same-host resume. The expected proof value is not in the model prompt.
The matcher currently requires Codex and an explicit first repo directory;
repository/template/routine smoke modes cannot be combined with this proof mode.
This procedure is not evidence of a real-host pass.

Stacked on repository checkout #1494. No migration or deployment is performed by
this PR; matching normal server/runtime artifacts are released normally, with
no manual artifact publication step. This slice does not claim Docker image
building or complete issue-wide acceptance.
