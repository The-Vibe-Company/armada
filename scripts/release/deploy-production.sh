#!/usr/bin/env bash
# Run only in a protected staging/release job, with cwd on the pinned source checkout.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
for key in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID \
  RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID RAILWAY_SERVICE_ID \
  VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID ARMADA_SERVER_URL RELEASE_SHA RELEASE_VERSION; do
  [[ -n "${!key:-}" ]] || fail "Missing deployment environment secret/configuration: $key. See docs/releasing.md."
done
[[ "$(git rev-parse HEAD)" == "$RELEASE_SHA" ]] || fail 'Checkout does not match validated release SHA.'
[[ "$ARMADA_SERVER_URL" == https://* ]] || fail 'ARMADA_SERVER_URL must use HTTPS.'
# No provider API receives the orchestration/tooling checkout or local caches.
source_dir=$(mktemp -d)
trap 'rm -rf "$source_dir"' EXIT
git archive "$RELEASE_SHA" | tar -x -C "$source_dir"
# git archive intentionally omits generated release metadata. Carry only the
# validated public pin into the source-built server, never the tooling checkout.
pin=packages/core/src/official-sandbox-image.json
if [[ -f "$pin" ]] && jq -e 'type == "object"' "$pin" >/dev/null; then
  jq -e --arg version "$RELEASE_VERSION" '.version == $version and (.image | test("^ghcr[.]io/the-vibe-company/armada-sandbox@sha256:[a-f0-9]{64}$"))' "$pin" >/dev/null \
    || fail 'Official sandbox image pin does not match this release.'
  cp "$pin" "$source_dir/$pin"
fi
cd "$source_dir"

supabase link --project-ref "$SUPABASE_PROJECT_ID"
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked --yes
supabase migration list --linked
# Discard CLI link metadata before either provider uploads the source tree.
rm -rf supabase/.temp

# --ci can finish after build logs; explicitly poll this upload's deployment ID instead.
upload=$(railway up --detach --json --project "$RAILWAY_PROJECT_ID" \
  --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID" \
  --message "Release $RELEASE_VERSION ($RELEASE_SHA)")
deployment_id=$(jq -er '.deploymentId | select(type == "string" and length > 0)' <<< "$upload")
echo "Waiting for Railway deployment $deployment_id"
deadline=$((SECONDS + 900))
while (( SECONDS < deadline )); do
  deployments=$(railway deployment list --json --project "$RAILWAY_PROJECT_ID" \
    --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID")
  status=$(jq -r --arg id "$deployment_id" '.[] | select(.id == $id) | .status' <<< "$deployments")
  case "$status" in
    SUCCESS) break ;;
    FAILED|CRASHED|REMOVED|SKIPPED) fail "Railway deployment $deployment_id ended in $status; dashboard/npm not released." ;;
  esac
  sleep 10
done
[[ "${status:-}" == SUCCESS ]] || fail "Timed out waiting for Railway deployment $deployment_id."
# The configured public server must actually serve this version, not just pass a generic health check.
healthy=false
for _ in {1..12}; do
  if curl --fail --silent --show-error --max-time 15 "${ARMADA_SERVER_URL%/}/healthz" \
    | jq -e --arg version "$RELEASE_VERSION" '.ok == true and .version == $version' >/dev/null; then
    healthy=true
    break
  fi
  sleep 5
done
[[ "$healthy" == true ]] || fail 'Public server did not report the release version; dashboard/npm not released.'

# Upload the repository root: Vercel project Root Directory remains apps/dashboard,
# with workspace sources outside that directory included in its build settings.
# deploy waits for Ready (no --no-wait), then promotes domains only on successful build.
if [[ "${PREBUILT_DASHBOARD:-}" == true ]]; then
  # Staging builds on the Actions runner, including the release smoke call.
  # VERCEL_TOKEN is read from the environment, never exposed in argv.
  vercel pull --yes --environment=production
  vercel build --prod
  vercel deploy --prebuilt --prod --yes \
    --meta "githubCommitSha=$RELEASE_SHA" --meta "armadaVersion=$RELEASE_VERSION"
else
  # Production stays unchanged until the owner confirms staging cutover.
  vercel deploy --prod --yes --token "$VERCEL_TOKEN" \
    --meta "githubCommitSha=$RELEASE_SHA" --meta "armadaVersion=$RELEASE_VERSION"
fi
echo "Released server and dashboard $RELEASE_VERSION from $RELEASE_SHA" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
