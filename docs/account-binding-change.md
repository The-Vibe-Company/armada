# Existing sandbox billing account (#1579)

The sandbox page and `armada status ID` identify the pinned account by name and
billing type (subscription or API key), not today's default or a guess from the
model name. Unreadable metadata stays unavailable. Admitted turn pricing retains
its original account/version context.

`armada bind-credential ID --credential-id ACCOUNT_ID [--org ORG]` changes the
owner's account on supported stopped or ready sandboxes. Ready compute is safely
stopped first; the next message resumes the workspace/conversation with fresh
credentials. No running turn is interrupted for an account change. Idle-paused
is a retained stopped state. If stop is still pending, wait for stopped and retry;
uncertainty never becomes an optimistic pin change. Starting, stopping, running
and leased states return explicit guidance, not not-found for an owner. The same
confirmed operation is available on the owner's sandbox page.

Support: Boat runtime, Modal dialout/native retained machines and owned Docker
runtime. Native Modal updates private policy/labels atomically with the public
pin. Runtime configuration is revoked by the existing lifecycle-generation trigger
and recreated at enrollment. OpenCode requires the target account to support the
retained model; incompatible custom/plan model namespaces are refused before stop.

## Remaining owner-request gaps

**Native Boat cannot safely switch yet.** Its retained environment and native
auth/broker files must be replaced before the next prompt. Updating only the pin
would lie about billing. `credential_binding_unsupported` refuses the operation
before stopping compute or changing the pin and explains the limitation (#1579).
Launch a new sandbox with the desired account for now. This means the full owner
requirement is NOT complete.

Default-path audit: ordinary dashboard/CLI/REST/MCP launches and unpinned templates
use the shared resolver's compatible personal default, then sole personal account.
Ambiguous or invalid personal selection fails; org default/sole selection occurs
only when no compatible personal accounts exist. Routines resolve as the persisted
execution owner; unpinned templates choose the current default per occurrence.
Explicit template/launch pins remain explicit. No ordinary fallback to a second
account was found when a valid compatible personal default exists.

Direct Docker launch, Armada-access parent launch and scoped child launch still
require explicit account selection: omission is refused, not silently billed to
another account. Scoped children additionally require an account/version allowed
by the parent's grant. Omission/default support on these paths remains #1579 work
and must not broaden delegated account permissions.

## Coordinator verification after normal deployment

For each supported placement, inspect the account name/type in status and the
page. Choose a compatible subscription from an API-key sandbox with an idle turn;
verify the next message recalls prior context and uses fresh selected-account
auth. Repeat from stopped and idle-paused. During a turn verify refusal without
interrupting it or changing the pin. Verify other members and wrong-org tokens
cannot switch the owner's account. Native Boat must report its explicit limitation
without claiming success. This is a procedure, not live staging evidence.
