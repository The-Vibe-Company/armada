# Golden checkout authentication challenge failure

Issue #1694 production evidence: build ff0718ad-2a15-4abe-b840-7bf7865769f5
passed admission/authorization, then failed checkout_baseline with checkout exit128.
This is not a capacity refusal. The newly requested repository was private and
735MB; neither size nor the number of installed Apps proves the Git failure cause.

## Reproduced defect

The previous generated Git credential helper accepted only protocol and host
attributes. Git supplies HTTP WWW-Authenticate headers as wwwauth[] attributes,
and may supply an existing username. See the official
[Git credential protocol](https://git-scm.com/docs/git-credential.html).
Our helper rejected those fields before returning the cached caller/scoped token.
An isolated git credential fill with synthetic credentials, no network and
system/global helpers disabled succeeds with protocol+host and exits128 after
adding a Basic-auth challenge. The shell regression also exercises the generated
checkout frame without real Git or any external credential helper.

The fix tolerates non-authority credential metadata but still requires explicit
HTTPS and exactly github.com (optionally port443). Other hosts, HTTP and absent
host information receive no credentials. Store/erase operations do not persist
credentials. Caller authorization and installation-scoped token selection are
unchanged: this repair applies to both token paths and never substitutes another
App's credentials to bypass user authorization.

The production stderr was discarded, so the exact old Git error line cannot be
recovered. This is a reproducible sufficient cause consistent with private-repo
authentication, not proof that the unseen production stderr had a particular line.
No production rebuild was executed by this worker.

## Safe diagnostics

Each clone streams stderr through an in-memory classifier; no raw stderr, file
path, server payload or token is stored or forwarded. Only a closed reason and
repository index leave the builder. SSH resolves the index through trusted
requested-repository metadata, never a guest-supplied name. Status retains the
checkout phase and curated actionable text, for example:

    Could not clone owner/repo: GitHub credentials were rejected. Grant your account and the Armada GitHub App read access, reconnect GitHub, then rebuild.

Other closed reasons distinguish missing/inaccessible repository, missing branch,
network transfer failure (including early EOF/index-pack), LFS failure, existing
destination and storage exhaustion. Unknown failures remain explicitly unknown.
The existing job/status/CLI/dashboard safe-reason pipeline publishes this text;
the last-good golden remains canonical on failure. No shallow-clone, timeout,
capacity or snapshot-publication policy was changed.
