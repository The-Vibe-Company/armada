# Change an existing sandbox's model account (#1176, slice 3)

Account changes retain the logical workspace and conversation history. They do
not recreate a sandbox from its golden. The server verifies owner authority,
current membership, harness compatibility and account eligibility; a dashboard
selection alone is never permission to use a credential.

## Explicit selection

- Dashboard: open your sandbox, expand **Details → Change account**, select an
  eligible account and confirm. The selected account's current revision is used,
  including when reconnecting the same account after replacement.
- CLI: `armada repoint-credential <sandbox-id> --credential-id <account-id>`
  (`--org UUID` and `--json` are supported).
- API: `POST /api/v1/sandbox/repoint-credential` with `id`, `credentialId` and
  optional `org`. The receipt contains safe IDs/revision, harness, `status: bound`
  and a fixed-English note; never credential values.

Active or uncertain work must settle first. Applying a change can stop and
restore idle compute so the native harness actually receives the new account;
files and conversations are retained, not running background processes. Stop
long-running development processes yourself when needed. Provider failures must
not silently select another account or claim the handoff succeeded.

## Missing-pin fallback

On an ordinary prompt, a known pinned account that is gone/deleted can switch to
an eligible **personal default of the sandbox owner** for the same harness.
The new binding is persisted and delivered before inference. The response,
status and dashboard show a visible account-change note. Another caller's
personal default is never used for the owner, and a valid pin is not silently
changed. A replaced, revoked or expired account is not treated as a missing pin:
use explicit selection/reconnection. An unbound legacy workspace is not inferred
to have had a removed account.

If there is no eligible personal default, the existing refusal remains; choose
an account explicitly. The legacy rotating-session ownership checks still apply
on deployments without the separately delivered shared-refresh implementation.
This slice does not bypass those checks or distribute a shared refresh token to
multiple native writers.

## Private handoff and retry

The handoff has a durable delivery-pending barrier. Normal prompts/exec/public
output must not use a database pin whose native delivery is incomplete. The
pending target survives a server interruption; retry the account change (or the
next owner prompt) after the provider operation settles. The pending UI is not
a success receipt. An uncertain command outcome may require a safe **Stop** before
retrying. A still-active server call must settle (abandoned admissions expire
after 15 minutes); normal Stop/TTL and concurrent ordinary commands remain
available. Changed/revoked credentials or membership are rechecked
before acknowledgment.

Boat's immutable parent environment is not a credential update. The server uses
fixed private SSH-stdin delivery and a harness-only override, scrubbing obsolete
auth material. Modal updates both its public binding and retained native policy
before bootstrapping the new account. Old redaction material remains sealed on
the server, including keys removed from the default selection; values are never
returned, logged or put into command arguments. A failed environment capture leaves only ciphertext, encrypted to an ephemeral
server-held private key. Native handoff revisions fence stale operations. Old conversation/usage history must not be reassigned to the
new account merely because its current pin changed. Until per-binding quota
receipts are available, account allowance/profile probing of repointed history
is intentionally unavailable rather than attributing old profile data to the new
account. This does not block inference or erase recorded turn/runtime usage.

## Deployment and required coordinator checks

Apply the included new migration before deploying the matching server,
dashboard and native runtime. Rebuild the runtime using the repository build
procedure. No production or real-provider migration/test was run by this PR
author; local tests use synthetic accounts and controlled transports.

On **both Boat and Modal**, using disposable staging resources:

1. Run an initial prompt on a disposable API-key account and record a harmless
   workspace sentinel and conversation ID. Configure an eligible owner default
   for the same harness. Remove the old Armada account; revoke only that
   disposable vendor key if testing actual native selection. Send another
   ordinary prompt. It must succeed on the new account, preserve the sentinel
   and conversation, persist the new pin and show the fallback note in API/CLI
   and dashboard. Test OpenAI→ChatGPT/Codex and Anthropic→Claude setup-token.
2. Explicitly select another account and a fresh revision of the same account.
   Verify actual native authentication uses the selection, not the provider's
   old environment, without printing credentials. Wrong-harness, non-owner and
   unavailable accounts must refuse without silently borrowing another key.
3. Keep one conversation active while a different latest conversation has
   finished. Account changes must not silently stop the active work. Repeat with
   an active command/uncertain native observation and verify safe refusal.
4. Interrupt private delivery after selection is persisted, then retry after a
   server restart/provider recovery. Pending state must block inference and
   unregistered output; a matching retry must complete without a new workspace.
   A stale earlier operation must not overwrite newer native credentials.
5. Remove membership or replace/delete the target during delivery. No stale
   ready-success acknowledgment is allowed. Verify the next authorized retry can
   recover. Compare redaction fixture canaries privately; never put actual token
   values into prompts, artifacts or logs.

Record deployed commits, provider/harness, safe account revisions and prompt
IDs/outcomes, not auth payloads. The three-concurrent-sandboxes-through-refresh
acceptance remains the separate slice-2/coordinator check; fallback to a shared
subscription requires that implementation as well.
