#!/usr/bin/env bash
# Run under both production release and migration locks after approval.
set -euo pipefail
fail() { echo "::error::$*" >&2; exit 1; }

plan=$(bun scripts/release/rollback.ts plan)
target=$(jq -er '.previous.tag' <<< "$plan")
target_sha=$(jq -er '.previous.sha' <<< "$plan")
target_version=${target#v}
printf 'tag=%s\nphase=pre-mutation checks\n' "$target" >> "${GITHUB_OUTPUT:?}"
required=(RAILWAY_TOKEN RAILWAY_PROJECT_ID RAILWAY_ENVIRONMENT_ID RAILWAY_SERVICE_ID
  VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID SUPABASE_DB_URL SUPABASE_DB_PASSWORD)
for key in "${required[@]}"; do
  [[ -n "${!key:-}" ]] || fail "Missing rollback configuration: $key"
done

tools_dir="$PWD/scripts/release"
archive=$(mktemp -d)
trap 'rm -rf "$archive"' EXIT
git archive "$target_sha" | tar -x -C "$archive"
pin="$archive/packages/core/src/official-sandbox-image.json"
image=$(jq -r '.targetImage // empty' <<< "$plan")
if [[ -n "$image" ]]; then
  jq -n --arg version "$target_version" --arg image "ghcr.io/the-vibe-company/armada-sandbox@$image" \
    '{version: $version, image: $image}' > "$pin"
else
  printf 'null\n' > "$pin"
fi
jq -n --arg commit "$target_sha" '{commit: $commit}' > "$archive/packages/mcp-server/src/source-identity.json"

railway_scope=(--project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID")
list_deployments() { railway deployment list --json "${railway_scope[@]}"; }
dashboard_id() { RELEASE_SHA="$1" bun "$tools_dir/stage-skip.ts" dashboard-id; }
server_healthy() {
  curl --fail --silent --show-error --max-time 15 "${ARMADA_SERVER_URL%/}/healthz" \
    | bun "$tools_dir/deployment-health.ts" "$1" "$2"
}
current_sha=$(jq -er '.current.sha' <<< "$plan")
current_tag=$(jq -er '.current.tag' <<< "$plan")
current_server=$(jq -er '.currentServer' <<< "$plan")
current_dashboard=$(jq -er '.currentDashboard' <<< "$plan")
target_dashboard=$(jq -er '.targetDashboard' <<< "$plan")

cd "$archive"
jq -c '.migrations' <<< "$plan" | bun "$tools_dir/rollback.ts" verify-history \
  || fail 'rollback: refused (live migration history differs or is unavailable)'

bun "$tools_dir/rollback.ts" verify-dashboard "$target_dashboard" "$target_sha" \
  || fail 'rollback: refused (target dashboard deployment unverified)'
[[ "$(dashboard_id "$current_sha")" == "$current_dashboard" ]] \
  || fail 'rollback: refused (current dashboard deployment changed)'
list_deployments | jq -e --arg id "$current_server" '.[0] | .id == $id and .status == "SUCCESS"' >/dev/null \
  && server_healthy "${current_tag#v}" "$current_sha" \
  || fail 'rollback: refused (current Railway deployment changed)'

printf 'phase=Railway upload requested\n' >> "$GITHUB_OUTPUT"
upload=$(railway up --detach --json "${railway_scope[@]}" --message "Rollback to $target ($target_sha)")
deployment=$(jq -er '.deploymentId | select(test("^[a-f0-9-]{36}$"))' <<< "$upload")
printf 'railway_id=%s\n' "$deployment" >> "$GITHUB_OUTPUT"
echo "Waiting for Railway deployment $deployment"
deadline=$((SECONDS + 900))
server_ready=false
while (( SECONDS < deadline )); do
  status=$(list_deployments | jq -r --arg id "$deployment" '.[] | select(.id == $id) | .status') || status=
  case "$status" in
    SUCCESS)
      if server_healthy "$target_version" "$target_sha"; then
        server_ready=true
        break
      fi
      ;;
    FAILED|CRASHED|REMOVED|SKIPPED) fail "Railway rollback ended in $status" ;;
  esac
  sleep 5
done
[[ "$server_ready" == true ]] || fail 'Railway rollback did not reach the expected SHA before the deadline'

[[ "$(dashboard_id "$current_sha")" == "$current_dashboard" ]] \
  || fail 'Dashboard changed while restoring Railway. Inspect both hosts before recovery.'
printf 'phase=Vercel rollback requested\n' >> "$GITHUB_OUTPUT"
vercel rollback "$target_dashboard" --yes --timeout 3m
[[ "$(dashboard_id "$target_sha")" == "$target_dashboard" ]] \
  && server_healthy "$target_version" "$target_sha" \
  || fail 'Rollback could not verify both restored hosts'
printf 'phase=both hosts verified\n' >> "$GITHUB_OUTPUT"
echo "rollback: restored $target ($target_sha)"
