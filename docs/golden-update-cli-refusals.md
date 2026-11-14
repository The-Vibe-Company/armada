# Snapshot update: replacement, addition and refusal diagnosis

## What 2.29.0 actually does

This trace uses release source commit
5ea7e30c65e66e82aebcd298f487da50ff08a75e (v2.29.0), not an assumption about
which binary the owner ran.

Command examples below use the current `snapshot` command. Older CLI versions, including 2.29.0,
use `golden` instead (snapshot was called golden in older versions).
Historical diagnostic families in the table retain their original wording.

**--repo replaces the entire list.** It does not append. With five stored
repositories, update NAME --repo https://github.com/owner/new.git requests a
new snapshot containing only that one repository. Omitted --init means an empty
init list. The old snapshot remains canonical until a successful publication;
a successful replacement drops the other five repositories from the new config
and snapshot. This is not a GitHub refusal by itself.

The new --add-repo mode preserves all stored repositories, their branches and
directories, and init commands. It uses a distinct server endpoint, not a
client-side list/read/overwrite fallback:

    armada snapshot update two-repos-prod-test --provider boat --org <org-id>       --add-repo https://github.com/owner/new.git@main

Repeat --add-repo for multiple additions. Do not combine it with --repo, --config,
--init or --setup. To change an existing branch, directory or init command, use a
complete --config intentionally. Re-adding the same canonical repository and
branch is a no-op in the merged config, enabling idempotent receipt recovery.
Conflicting branches/directories or exceeding the 16-repository total refuse
before admission rather than discarding old entries.

## CLI versus server version and error codes

Read-only commands:

    armada --version
    armada account status --json
    armada snapshot list --provider boat --org <org-id> --json
    armada snapshot capabilities --provider boat --org <org-id>

--version is the CLI version; account status includes the server version and
the authenticated user/org scope. Packages on unreleased branches may still
print 2.29.0, so equal version strings do not establish feature parity.

In release 2.29.0 the backend slot wrapper throws conflict and HTTP maps it to
409. But the default CLI API adapter translates non-401/non-403 failures into
AuthError(unavailable): the observed JSON code unavailable does **not** establish
that the server returned 503. Updated create/update clients preserve the server
code, and update adds next-action guidance. The server conflict mapping and
failed-build diagnostics remain intact.

An old CLI rejects --add-repo as an unknown option: upgrade the CLI. A new CLI
against an older server receives unknown_route/404 for update-add-repos: upgrade
the server, then retry. It never falls back to --repo replacement. An older
server without durable update routes also needs upgrading. Malformed/missing
config or idempotency fields from mismatched clients should not be repaired by
blindly resubmitting a different request. If an older server returns a synchronous
snapshot result instead of a durable job receipt, the new CLI reports version
skew/unknown outcome and refuses to poll an undefined job. Inspect snapshot list
before retrying: the operation might already have completed.

## Every refusal boundary on the 2.29.0 update path

For arbitrary invalid flags/configs, the exact message names the invalid field.
The following inventory groups those validation variants by their owning guard.
A refusal before a Build job line is not a failed checkout. The printed admission
key exists even if admission was refused and no durable job was created.

| Boundary / public message family | Meaning and next action |
| --- | --- |
| Unknown command/option, missing option value, repeated single option, wrong positional count | Check armada --help and the CLI version. Supply one snapshot name and supported flags. --add-repo is new and update-only. |
| A golden needs at least one --repo; invalid git URL/branch/name/directory; duplicate explicit directory; non-GitHub repository | For replacement repeat ALL desired full GitHub URLs, optionally @branch, or supply complete valid --config. Use --add-repo to append instead. Bare owner/repo is not a valid replacement CLI git URL in 2.29.0. |
| Could not read config/setup file; config not JSON; unknown config/repository keys; invalid init array/commands; secret-shaped config keys/assignments; limits (16 repos/32 init commands) | Fix the named local file/field; remove secrets and deliver them through the separate secrets boundary. Do not send credentials in repository URLs, config, arguments or setup. |
| Invalid --provider, --timeout outside 0–600; invalid idempotency key | Choose boat/modal, a bounded local polling timeout, and a stable 16–128-character key of letters/digits/underscore/hyphen. Local timeout is not a server build deadline. |
| Set ARMADA_TOKEN or run armada login; expired/revoked session; HTTP 401; invalid Armada URL | Sign in to the intended server as the actual snapshot owner/admin, or repair the service-token/server URL configuration. Never paste token values into diagnostics. |
| No organization, ambiguous organization, not a member, token scoped to another organization | Use --org with the intended membership and the matching authenticated token. Check account status. |
| Secure golden creation is not configured on this server; unknown route; config/idempotencyKey required | Check server configuration and CLI/server compatibility. Upgrade together; do not fall back from addition to replacement. |
| No golden named NAME / no visible selected-provider row | Check snapshot list under the same caller/org; fix name, --org or --provider. Private snapshots are owner-only, even for admins. Hidden resources are intentionally indistinguishable from absent ones. |
| Golden exists on boat and modal. Pass --provider boat or modal. | Supply --provider boat or --provider modal. There is no implicit first-provider choice and no build is admitted. Same-provider duplicate names also require administrative disambiguation. |
| Only an admin can change an org golden; You cannot build this golden; target authorization changed | Use the private owner or current org admin; refresh membership/visibility evidence before retrying. A permission change is not a quota problem. |
| Provider not configured, missing/refused provider credential, management authority/binding cannot be verified | Have an administrator restore the original provider connection and immutable binding in Settings. A provider label is not account identity; do not adopt another account's snapshot. |
| Provider rate limit/payment/permission/invalid-request refusal while resolving identity | Follow the provider's bounded rate-limit time, fix billing/credits or administrator-managed credentials. Do not interpret it as repository authorization or allocate a second snapshot. |
| Provider golden capacity invalid; backend identity missing/unverifiable; Boat durable build missing reservation | An administrator must repair provider capacity/identity/admission configuration. Retrying a config change cannot repair these invariants. |
| Golden capacity or binding is unavailable or busy | 2.29.0 conflates a missing/wrong binding and active/stale reservation. Rebuild already uses the SAME slot: capacity one alone does not require a second slot. Inspect the existing job/binding with an administrator; do not create a second snapshot or clear a live reservation. Updated diagnostics distinguish these causes and identify a blocking job when known. |
| Idempotency key was used for a different build | Recover status using that key. Reuse it only for the identical request; use a new key only after the prior outcome is known. |
| Golden changed before build admission / build provider, source, binding or authorization changed | Re-read list/status under the intended caller and rebuild from the current revision. Never overwrite or repair bindings implicitly. |
| Durable transactions unavailable; SQL outage/internal error; provider unavailable; HTTP 5xx | Ask an administrator to check server/database/provider health. Recover the printed admission key before any retry if delivery was uncertain. No such build means no visible admission, not a clone failure. |
| The server did not answer in time; Armada could not reach the server; polling stopped | Outcome may be unknown. Recover by printed key/job ID instead of using a new key or resending a changed replacement list. |

After admission, 2.29.0 could fail during caller GitHub authorization (including
new private-repository App coverage), builder creation, checkout, baseline
packages, init, secret scan, snapshot or publication. Those are **failed builds**,
not the preceding admission refusals. The reason-preservation work is retained:
updated servers preflight repository access at admission and store curated safe
reason/phase for later failures; CLI build-status and dashboard display them.
No raw stderr, command text, matched secret or upstream error is published.

## Read-only discrimination and retry

    armada snapshot build-status --idempotency-key <printed-key> --org <org-id>
    armada snapshot build-status <known-job-id>

The key lookup is requester-scoped; use the same user's identity. No such build
after an immediate refusal is expected. Do not invent a builder failure from a
missing receipt. After the actual blocker is resolved and the additive feature
is released, use the --add-repo command above. No production rebuild was run to
validate this document.
