# Refresh repositories when launching a snapshot

## Credential contract

Build authorization and launch authorization are different actors/lifetimes.
Golden builders use short-lived scoped installation credentials; a launch must
act as the **launching caller**, never reuse the golden owner's build token.

Before refresh, native launch installs its caller credential helper and enrolled
runtimes prepare their authorized GitHub broker/helper. The shared core refresh
now preserves that helper: the old per-command credential.helper= reset disabled
it and made private repositories prompt with terminal prompts disabled.

No new token is put in command arguments, logs, remote URLs, Git config or a
refresh file. Helpers reference the existing caller environment/broker rather
than embedding a value. Refresh does not persist another credential copy; normal
native/runtime credential lifetime and revocation rules remain in force. It
never copies worker authentication back into the golden. Unit tests guard the
command/secret boundary without a private smoke repository.

## Before allocating compute

The shared core launch policy invokes the server repository-access port before
beginOperation/fork. When GitHub is configured it checks only requested GitHub
repositories using the caller's resolved connection (or anonymous public access).
Private metadata is followed by a read of the requested Git ref, so metadata-only
permission does not masquerade as contents access. Credentials are headers to
GitHub's fixed API origin; redirects are refused.

A known 401/403/404 access refusal blocks with code no_credentials and the
repository directory plus armada github connect/grant-access instructions. No
compute or sandbox row is allocated. Missing connection with unknown public
visibility also blocks conservatively; do not infer that an inaccessible repo is
public because GitHub is unavailable. Authenticated preflight transport/rate-limit
outages are not proof of denial: the actual refresh classifies its own outcome
when caller credential setup can still complete. Required broker/enrollment or
unknown credential-delivery failures remain blocking; they are not safe Git-fetch
fallbacks. Legacy integrations without the port can only diagnose authorization at refresh.

Runtime-only preflight resolves the caller connection server-side but does not
add its token to harness credentials/environment. Docker snapshot launches use
the same caller-access port before host admission and recheck it in deferred
workers; proven-public snapshots remain anonymous-capable after disconnection.
Fresh image launches that explicitly clone requested repositories retain their
existing connection-required preflight. Runtime enrollment boundaries remain intact.

## Refresh failure policy

One core path is used by native Boat/Modal, enrolled Boat/Modal workspaces and
ordinary Docker snapshot launches. Docker runs refresh after its enrolled GitHub
helper is prepared; it neither re-clones baked repositories nor replays init
commands already baked into the image. Each repository performs a fetch, then a
fast-forward-only merge (with the existing tag-following behavior preserved):

- Authorization refusal blocks launch with no_credentials and a repository-specific
  reconnect/access remedy, not unavailable. HTTP/MCP preserve the code; CLI keeps
  the code and message in JSON output.
- A **completed fetch** with a recognized transient Git transport/HTTP failure can
  continue on the existing snapshot checkout. Fetch cannot modify that checkout;
  the merge is not executed. A visible warning names the repository in launch's
  GitHub message (CLI Note/JSON and the normal API/MCP response).
- A reserved fetch-failure exit code and exact protocol marker are both required
  before fallback. Raw merge/filter stderr cannot opt into fallback by echoing the
  marker alone.
- Unknown outcomes, provider exec throws/timeouts, detached work, merge/filter/LFS
  failures, divergent history, ownership refusals after the existing bounded
  ownership retry, and init failures still block. Do not claim the snapshot tree
  is unchanged after an unknown or partially applied checkout.
- Existing launch init commands still run after a safe transient-fetch fallback;
  Docker's already-baked init policy remains unchanged; no automatic
  network retry, reset --hard, credential bypass, token persistence or scan change
  is introduced.

A visible org snapshot remains the source authorization boundary for fallback;
this is not permission to read another user's private snapshot. Refresh warnings
never include raw upstream diagnostics or token values. A later successful refresh
can update the caller's sandbox normally.

## Coordinator acceptance (#1792)

After release, with the owner's approval re-add the private repository to the
Boat golden (preserve all five public entries; Armada history:shallow), then launch
as the same connected owner. Confirm the private working tree is present/current,
the response reports the caller's GitHub identity, and no credential appears in
commands, URLs or persisted checkout configuration. A disconnected/denied caller
must get the explicit repository access refusal without a fork where knowable.
A simulated fetch-only transport failure should report snapshot fallback visibly.

Production Boat verification is coordinator-only/on-demand, never CI. No private
repository is required in post-deploy smoke. This change adds no CI job or schema
migration and is not evidence that the production acceptance has passed.
