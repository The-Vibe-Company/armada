#!/usr/bin/env bash
# Run only in a protected staging/release job, with cwd on the pinned source checkout.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
required=(SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID
  VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID ARMADA_SERVER_URL RELEASE_SHA RELEASE_VERSION
  RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID RAILWAY_SERVICE_ID)
for key in "${required[@]}"; do
  [[ -n "${!key:-}" ]] || fail "Missing deployment environment secret/configuration: $key. See docs/releasing.md."
done
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid release SHA.'
[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]] || fail 'Checkout does not match validated release SHA.'
[[ "$ARMADA_SERVER_URL" == https://* ]] || fail 'ARMADA_SERVER_URL must use HTTPS.'
# Ordinary main runs supersede queued older sources before the first mutation.
# Explicit release/manual pinned calls do not set this flag and must never no-op.
if [[ "${STAGING_LATEST_ONLY:-}" == true ]]; then
  remote=$(git ls-remote --exit-code origin refs/heads/main)
  latest=$(awk '$2 == "refs/heads/main" { print $1 }' <<< "$remote")
  [[ "$latest" =~ ^[a-f0-9]{40}$ ]] || fail 'Could not resolve current main; no deployment started.'
  if [[ "$latest" != "$RELEASE_SHA" ]]; then
    echo 'superseded=true' >> "${GITHUB_OUTPUT:?Missing deployment step output file}"
    echo '::notice::Newer main superseded this staging source before deployment; no mutation or smoke started.'
    exit 0
  fi
fi
# This exception is explicit staging-only; production never reads main's schema.
history_tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/staging-migration-history.ts"
if [[ "${STAGING_FORWARD_HISTORY:-}" == true ]]; then
  git fetch --no-tags origin main
fi
# No provider API receives the orchestration/tooling checkout or local caches.
source_dir=$(mktemp -d)
railway_wait_pid=
cleanup() {
  if [[ -n "$railway_wait_pid" ]]; then
    kill "$railway_wait_pid" 2>/dev/null || true
    wait "$railway_wait_pid" 2>/dev/null || true
  fi
  rm -rf "$source_dir"
}
trap cleanup EXIT
git archive "$RELEASE_SHA" | tar -x -C "$source_dir"
# git archive intentionally omits generated release metadata. Carry only the
# validated public pin into the source-built server, never the tooling checkout.
pin=packages/core/src/official-sandbox-image.json
if [[ -f "$pin" ]] && jq -e 'type == "object"' "$pin" >/dev/null; then
  jq -e --arg version "$RELEASE_VERSION" '.version == $version and (.image | test("^ghcr[.]io/the-vibe-company/armada-sandbox@sha256:[a-f0-9]{64}$"))' "$pin" >/dev/null \
    || fail 'Official sandbox image pin does not match this release.'
  cp "$pin" "$source_dir/$pin"
fi
# Bundle the archive's identity, independent of Railway's optional/stale Git metadata.
jq -n --arg commit "$RELEASE_SHA" '{commit: $commit}' > "$source_dir/packages/mcp-server/src/source-identity.json"
health_tool="$(dirname "$history_tool")/deployment-health.ts"
skip_tool="$(dirname "$history_tool")/stage-skip.ts"
cd "$source_dir"

supabase link --project-ref "$SUPABASE_PROJECT_ID"
if [[ "${STAGING_FORWARD_HISTORY:-}" == true ]]; then
  history_file=$(mktemp)
  main_file=$(mktemp)
  # Keep the archive pinned: only version names, never newer SQL, enter this check.
  git -C "$OLDPWD" ls-tree -r --name-only FETCH_HEAD -- supabase/migrations > "$main_file"
  supabase migration list --linked > "$history_file"
  cat "$history_file"
  decision=$(bun "$history_tool" "$history_file" "$main_file")
  rm -f "$history_file" "$main_file"
else
  decision=apply
  supabase migration list --linked
fi
if [[ "$decision" == apply ]]; then
  supabase db push --linked --dry-run
  supabase db push --linked --yes
elif [[ "$decision" == skip ]]; then
  echo '::notice::Staging has only known forward migrations from main; skipping SQL apply, continuing exact-release deployment and smoke.'
else
  fail 'Invalid staging migration decision.'
fi
supabase migration list --linked
# Discard CLI link metadata before either provider uploads the source tree.
rm -rf supabase/.temp

# --ci can finish after build logs; explicitly poll this upload's deployment ID instead.
list_deployments() {
  railway deployment list --json --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID"
}
server_done=false
dashboard_done=false
if [[ "${RELEASE_RESUME:-}" == true ]]; then
  if deployments=$(list_deployments) \
      && status=$(jq -r '.[0].status // empty' <<< "$deployments") \
      && curl --fail --silent --show-error --max-time 15 "${ARMADA_SERVER_URL%/}/healthz" | bun "$skip_tool" server "$status"; then
    server_done=true
    echo "::notice::Skipping Railway upload: latest deployment succeeded and health reports $RELEASE_SHA."
  fi
  if bun "$skip_tool" dashboard; then
    dashboard_done=true
    echo "::notice::Skipping Vercel build and deploy: ready production dashboard reports $RELEASE_SHA."
  fi
fi
if [[ "$server_done" == false ]]; then
  upload=$(railway up --detach --json --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" \
    --message "Release $RELEASE_VERSION ($RELEASE_SHA)")
  deployment_id=$(jq -er '.deploymentId | select(type == "string" and length > 0)' <<< "$upload")
fi
wait_for_server() {
  echo "Waiting for Railway deployment $deployment_id"
  deadline=$((SECONDS + 900))
  while (( SECONDS < deadline )); do
    # A transient list/decode failure is retried within the same deadline; only a
    # terminal status or the deadline fails the release.
    status=
    if ! deployments=$(list_deployments) \
      || ! status=$(jq -r --arg id "$deployment_id" '.[] | select(.id == $id) | .status' <<< "$deployments"); then
      status=
      echo "Railway deployment list failed or was unparseable; retrying until the deadline."
      sleep 10
      continue
    fi
    case "$status" in
      SUCCESS) break ;;
      FAILED|CRASHED|REMOVED|SKIPPED) fail "Railway deployment $deployment_id ended in $status; dashboard/npm not released." ;;
    esac
    sleep 10
  done
  [[ "${status:-}" == SUCCESS ]] || fail "Timed out waiting for Railway deployment $deployment_id."
  # Prove the public route serves this exact source, not another same-version deployment.
  healthy=false
  for _ in {1..12}; do
    if curl --fail --silent --show-error --max-time 15 "${ARMADA_SERVER_URL%/}/healthz" \
      | bun "$health_tool" "$RELEASE_VERSION" "$RELEASE_SHA"; then
      healthy=true
      break
    fi
    sleep 5
  done
  [[ "$healthy" == true ]] || fail 'Public server did not report the expected version/commit; dashboard/npm not released.'
}

# Build the archived commit on the Actions runner for both protected environments.
# The Vercel project Root Directory remains apps/dashboard with workspace inclusion.
# VERCEL_TOKEN is consumed from the environment, never exposed in argv.
build_dashboard() {
  vercel pull --yes --environment=production
  vercel build --prod
}

if [[ "$server_done" == false && "$dashboard_done" == false && "${RELEASE_ENVIRONMENT:-}" == production ]]; then
  wait_for_server &
  railway_wait_pid=$!
  build_dashboard
  wait "$railway_wait_pid"
  railway_wait_pid=
else
  if [[ "$server_done" == false ]]; then wait_for_server; fi
  if [[ "$dashboard_done" == false ]]; then build_dashboard; fi
fi
# Wait for Ready; upload only the output, with no remote Vercel build.
if [[ "$dashboard_done" == false ]]; then
  vercel deploy --prebuilt --prod --yes \
    --meta "githubCommitSha=$RELEASE_SHA" --meta "armadaVersion=$RELEASE_VERSION"
fi
echo "Released server and dashboard $RELEASE_VERSION from $RELEASE_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
