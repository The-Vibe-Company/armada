# Server settings (Railway IaC)

This named partial owns only the existing server settings: Dockerfile build,
/healthz health check (180 seconds), ALWAYS restart, overlap 180 and drain 30.
Project variables are explicitly unmanaged: IaC must never read or write the
existing service secrets/configuration. It declares no source: Actions still uploads the clean validated source SHA.
IaC is NOT automatically applied by railway up.

## Owner cutover before the next release

Sources: [migration guide](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code)
and [DSL reference](https://docs.railway.com/infrastructure-as-code/reference).
Use CLI 5.71.0 (the Actions pin) and bun install --frozen-lockfile to install
our pinned TypeScript SDK. Do staging first from merged main, in an authorized
operator session, never from a PR. No new workflow is needed.

1. Run `railway link`, explicitly selecting the existing staging project,
   environment and server service. Confirm IDs match the staging Actions
   environment. Set `ARMADA_RAILWAY_SERVICE_NAME` locally to the exact existing
   service name, not UUID. The authoring file fails closed without this and a
   linked project name. Staging and production can have different names.
2. In that service's Railway Settings, clear the legacy **Railway Config File**
   path if set. This checkout removes railway.json. Railway blocks IaC planning
   for a service still managed by legacy Config as Code.
3. Run `railway config plan`. Only the seven settings above on the existing
   server may change. Reject creation, deletion, variable removal, source
   changes or unrelated resource changes. In CLI 5.71.0 a still-connected Git
   source can appear as a source-clear change even with its trigger disabled.
   If that occurs, stop: the owner must preserve the existing source in a
   reviewed environment-specific configuration before proceeding; do not
   accept source clearing as part of this settings-only migration.
   If another partial owns the service,
   stop and resolve ownership explicitly using Railway's documented ownership
   procedure; do not rename this partial to bypass it.
4. After reviewing the exact target and bounded plan, run `railway config apply`.
   Confirm the same changes; rerun `railway config plan` and require no changes.
   Keep Git autodeploy disabled.
5. Let the existing main Actions staging deployment run (or use the existing
   authorized pinned staging procedure). Record source SHA, Actions run and
   Railway deployment ID. Verify Dockerfile selection, /healthz readiness,
   health timeout 180, ALWAYS restart, overlap 180 and drain 30 in Railway.
   Confirm public health reports the expected version and the existing
   owner-enabled Modal/Docker smoke succeeds. Boat is not part of the release
   gate. Local SDK evaluation and green CI are not staging evidence.

After staging acceptance, the coordinator must repeat steps 1–4 for the existing
production project/environment/service **before the next publishing release**.
This is an owner prerequisite, not permission for an agent to touch production.
Production source deployment remains the exact-SHA staging-gated release path.
Record the reviewed production plan and subsequent release health separately;
staging does not prove production has been migrated.

No new Actions credentials, database changes or CI checks are required. For
rollback, retain prior live settings/source SHA and use an owner-reviewed IaC
plan. Restoring legacy CaC is not a lasting rollback: it stops being read on
2026-12-01.
