# Docker dashboard backend contract (#1165 / #1380)

The fixed interface was posted to #1380 before implementation. This first
increment ships authenticated host reads, additive launch discovery and types.
It does **not** enable the normal Docker launch/status/logs/CLI handler yet;
that is the next stacked backend PR. The private preview lane is unchanged.
Dashboard server actions call these routes as the signed-in user, with that
user's bearer and no forwarded browser Origin. Never use a Supabase service key.
No host table/ciphertext user-JWT grant, migration or dashboard edit is introduced.

## Host API

With ARMADA_DOCKER_HOSTS=1, bearer-only POST JSON:

- /api/v1/docker/hosts/list {org}: any current org member; DockerHostListResponse.
- /api/v1/docker/hosts/register-token {org}: current org admin; one-use five-minute
  DockerHostRegistrationResponse. Show the registration token once, never store/log it.
- /api/v1/docker/hosts/revoke {org,hostId}: current org admin; {revoked:true}.

List returns placement and hosts. Each host has id, name (currently null), state,
createdAt, lastSeenAt, revokedAt and sandboxes. State is pending for an unregistered
non-revoked host; online requires registration/current issuer membership and a
heartbeat within sixty seconds; otherwise offline. Revoked wins over all states.
Online is not proof of scheduling eligibility, capacity or runtime readiness.
The count includes retained/stopped/failed sandboxes, excluding deleted ones.
Only the selected org is read; current SQL membership, not stale bearer claims,
authorizes the read. No credential, registration capability, hash or installation
secret is returned. Without the host opt-in these routes remain absent/404.

## Discovery and exported types

POST /api/v1/launch/options retains its existing catalogs and boatRuntime field,
adding providers: LaunchProviderOption[]. Each describes its id, enabled,
launchSources, harnesses, capabilities and unsupportedReasons. Capabilities name:
launch, followupPrompts, stop, delete, resume, goldens, repositories, machineSizes, github, mcp,
skills, exec, steer, interrupt. Unsupported operations have short English reasons.
These describe installed feature support, never authorization or account health.

Docker is an image/Codex source. In this increment its normal launch/stop/delete
capabilities remain false, even when the private preview is enabled. The next
backend PR will supply the normal handler and enable only its working operations.
Host list placement likewise remains false until normal launch is available.
The UI can show enabled Hosts, but must not enable a normal Docker launch button
until capabilities.launch is true. No new request field can enable a capability.

DTOs are type-only exports from @armada/core's browser-safe dot entrypoint, including
host requests/responses, LaunchOptionsResponse, LaunchProviderOption/capabilities,
SandboxPlacementProviderId and the upcoming DockerLaunchRequest/Result and
DockerSandboxRecord/Status contract. Docker has goldenId/golden null, never a
fabricated golden or Boat alias. Golden provider identity remains Boat/Modal.
The staged normal launch contract is documented in the issue comment; types do
not imply a route is already implemented. No new workspace package is added.

## Exact coordinator check on the retained host

After deploying this server revision on staging with the existing opt-ins, start
the stopped daemon on the same host. No new registration or sandbox is needed.
Use Bash and the same SSH configuration and staging org from the passed check.
A live or stale daemon lock must be inspected, never deleted automatically.

```sh
set -euo pipefail
export DOCKER_SSH='YOUR_EXISTING_SSH_CONFIG_NAME'
export ARMADA_STAGING='https://armada-mcp-staging.up.railway.app'
export ARMADA_ORG='YOUR_STAGING_ORG_UUID'
env -u ARMADA_TOKEN ssh -- "$DOCKER_SSH" 'set -eu; umask 077; state="$HOME/.local/state/armada-docker-smoke"; test -f "$state/state.json"; test ! -e "$state/daemon.lock"; test ! -L "$state/daemon.lock"; nohup setsid "$HOME/.local/bin/armada-docker-host" run --state-dir "$state" >"$state/daemon.log" 2>&1 </dev/null & echo $! >"$state/smoke.pid"'
read -r -s -p 'Staging signed-in user bearer: ' ARMADA_TOKEN; printf '\n'
export ARMADA_TOKEN
python3 - <<'PY'
import json, os, time, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None
opener = urllib.request.build_opener(NoRedirect)
def post(path, body):
    req = urllib.request.Request(os.environ['ARMADA_STAGING']+'/api/v1/'+path,
        data=json.dumps(body).encode(), method='POST', headers={
          'authorization':'Bearer '+os.environ['ARMADA_TOKEN'], 'content-type':'application/json'})
    with opener.open(req, timeout=30) as response:
        assert response.headers['cache-control'] == 'no-store'
        return json.load(response)
options = post('launch/options', {})
docker = next(p for p in options['providers'] if p['id'] == 'docker')
assert docker['enabled'] and not docker['capabilities']['launch']
assert docker['unsupportedReasons']['resume']
for attempt in range(31):
    listing = post('docker/hosts/list', {'org':os.environ['ARMADA_ORG']})
    host = next(h for h in listing['hosts'] if h['id']=='70bde9cd-36c9-40af-b15e-65b2f9d3c2a2')
    assert set(host)=={'id','name','state','createdAt','lastSeenAt','revokedAt','sandboxes'}
    assert not listing['placement']  # until normal API/CLI integration lands
    if host['state']=='online': break
    if attempt==30: raise SystemExit('Host heartbeat not online within 60 seconds; inspect private daemon log')
    time.sleep(2)
print(json.dumps({'host':host,'docker':docker}))
PY
unset ARMADA_TOKEN
```

Expect the retained HOST_ID online with the existing inventory/count and no
credential fields. Admin register/revoke behavior is unchanged; members can list
but cannot mutate hosts. The daemon may be stopped by the coordinator afterward.
For this first increment, placement=false and capabilities.launch=false are
intentional. Re-run the adjusted normal-launch acceptance from the next backend PR.
No worker staging access, SSH, deployment, inference or remote migration was used.
