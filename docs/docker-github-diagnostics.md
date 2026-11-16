# Docker GitHub launch diagnosis (#2357)

The production 2.46.4 report alone does not identify an HTTP response-shape
mismatch. Do not infer one from the old wrapper's `request: invalid_response`.

## Established code evidence

- The shared GitHub wrapper selects a repository from `--repo`, `GH_REPO`,
  or the current Git remote **before** opening the credential socket.
  `gh auth status` in /home/user without a remote can fail locally without
  making any credential request. The updated diagnostic distinguishes
  `repository_selection`, `broker_request`, and `broker_response`.
- GitHubBroker previously collapsed transport, HTTP denial, JSON parsing and
  token validation failures into one error, then returned an empty IPC 403.
  It now returns only allowlisted error codes, never upstream response text.
- Current Docker normal launch already clones explicit manifest repositories
  and checks exitCode/timedOut before returning a completed receipt or sending
  its first prompt. Snapshot repositories take the separate refresh path.
  A hard-coded null repositoryDir in Docker response projections is not proof
  that checkout did not run. Do not diagnose missing files from that field.
- Docker prompt admission previously hard-coded /home/user even after explicit
  repository checkout. It now starts initial and later prompts in the first
  explicit launch repository. No-repository launches retain /home/user.
  The golden-only immutable repository_dir database column remains unchanged;
  Docker derives prompt cwd from its encrypted, normalized launch manifest.
- Without configured repositories the Docker launch advertises GitHub as
  unavailable; it does not grant unrestricted GitHub access.
- Modal uses the same wrapper and broker, so it receives these diagnostics too.
  Its golden repository binding differs from Docker's encrypted launch manifest.
- provider-parity-smoke already includes Docker --repo launch and authenticated
  GitHub clone/push probes; no real Git/gh unit replay is added here.

## Coordinator evidence required

On staging, use the official image and matching server release. Launch Docker
with an explicit repository and with no repository, both with and without an
initial prompt. Retain the launch JSON (including github/statusReason), server
version, image digest and account kind (Codex subscription versus
OpenAI-compatible account). The owner also reported a Boat Morph-account failure
while Codex subscription launches worked; that account/runtime-path comparison
remains necessary and is not explained by the Docker cwd repair.
Do not collect capabilities, tokens, environment or
upstream response bodies.

For the explicit-repository sandbox run, through Armada exec:

1. Ask the agent to report its initial working directory; it should be
   /home/user/<configured-dir> for explicit Docker repositories. Repeat after
   a later send. For exec use explicit cwd: its default remains /home/user.
   Run `test -d /home/user/<configured-dir>/.git` and
   `git -C /home/user/<configured-dir> rev-parse --show-toplevel`.
2. From that checkout, `gh repo view --json nameWithOwner`; separately
   `gh api repos/<owner>/<repo> --jq .full_name` to test an explicit selector.
3. Run the owner-enabled Docker GitHub provider-parity smoke, which verifies
   authenticated clone and receive-pack dry-run (no remote branch is written).
4. Repeat the explicit-selector check on Modal.

If only bare `gh auth status` outside a checkout fails with
repository_selection, that is a local selector failure, not a renewal request.
If the updated wrapper reports github_credentials_http_denied, investigate the
server credential route's authorization/binding; http_unavailable points to
non-authorization HTTP failure (including missing route/gateway).
invalid_json/invalid_token distinguish successful HTTP with an incompatible body.
github_credentials_unavailable denotes transport failure. broker_denied means an
old broker or a denied local IPC operation; verify the runtime/image version.
For a missing checkout retain the accepted launch request's repository selection
and completion/failure status for operator inspection of the encrypted manifest.
Production reproduction, if needed, is coordinator-only; this change has not
accessed or validated production.
