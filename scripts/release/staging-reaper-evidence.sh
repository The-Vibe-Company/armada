#!/usr/bin/env bash
set -euo pipefail

evidence="$RUNNER_TEMP/reaper-evidence.jsonl"
fail_evidence() {
  jq -cn --arg phase "$1" --argjson status "$2" \
    '{step:"smoke_reaper_evidence",pass:false,code:("reaper_" + $phase + "_failed"),phase:$phase,exitStatus:$status}' \
    | tee "$evidence"
  exit 1
}

[[ "$ARMADA_URL" == 'https://armada-mcp-staging.up.railway.app' ]] || fail_evidence staging_origin "$?"
scope=(--project "$RAILWAY_PROJECT_ID" --environment "$RAILWAY_ENVIRONMENT_ID" --service "$RAILWAY_SERVICE_ID")
deployments=$(timeout 15s railway deployment list --json --limit 20 "${scope[@]}") \
  || fail_evidence deployment_list "$?"
candidate_id=${1:-}
ids=$(jq -sr --arg candidate "$candidate_id" '
  if length != 1 or (.[0] | type) != "array" then
    error("expected one deployment list")
  else .[0] end
  | sort_by(.createdAt) | reverse
  | (map(.status) | index("SUCCESS")) as $current
  | if $candidate != "" and ($current == null or .[$current].id != $candidate) then
      error("candidate is not the live deployment")
    elif $current != null then .[$current:]
    else . end
  | map(select(.status == "SUCCESS" or .status == "REMOVED" or .status == "REMOVING"))
  | .[:2][] | .id | if test("^[a-f0-9-]{36}$") then . else error("invalid deployment ID") end
' <<< "$deployments") || fail_evidence deployment_selection "$?"
mapfile -t deployment_ids <<< "$ids"

filter='((@provider:modal OR @provider:docker) AND (@metric:reaper_unknown_machines OR @event:reaper_overdue_machines)) OR (@event:provider_reaper_retry AND @phase:discovery)'
read_logs() {
  timeout "$2" railway logs "$1" --deployment --json --since 15m --lines 500 "${scope[@]}" --filter "$filter"
}
previous_logs=
if [[ -n "${deployment_ids[1]:-}" ]]; then
  previous_logs=$(read_logs "${deployment_ids[1]}" 15s) || fail_evidence previous_deployment_logs "$?"
  previous_logs=$(jq -c '. + {previousDeployment: true}' <<< "$previous_logs") \
    || fail_evidence previous_log_decode "$?"
fi

checker="$(dirname "${BASH_SOURCE[0]}")/smoke-reaper-evidence.ts"
evaluate() {
  local report status=0
  report=$(printf '%s\n' "$1" "$previous_logs" | env -i PATH="$PATH" bun "$checker") || status=$?
  [[ "$status" == 0 || "$status" == 1 ]] || fail_evidence checker "$status"
  jq -ce 'if .pass then . else . + {code:"reaper_evidence_rejected"} end' <<< "$report" > "$evidence" \
    || fail_evidence evidence_decode "$?"
  return "$status"
}

if [[ -z "$candidate_id" ]]; then
  # Retain the outgoing overdue guard before deployment can age records out.
  outgoing_logs=
  if [[ -n "${deployment_ids[0]}" ]]; then
    outgoing_logs=$(read_logs "${deployment_ids[0]}" 15s) || fail_evidence outgoing_deployment_logs "$?"
  fi
  if evaluate "$outgoing_logs" || jq -e '.retryable == true' "$evidence" >/dev/null; then
    rm "$evidence"
    exit 0
  fi
  cat "$evidence"
  exit 1
fi

# The lane starts eligible and waits 60s after each sweep before the next.
deadline=$((SECONDS + 180))
while :; do
  remaining=$((deadline - SECONDS))
  if (( remaining <= 0 )); then break; fi
  query_timeout=$((remaining < 15 ? remaining : 15))
  current_logs=$(read_logs "$candidate_id" "${query_timeout}s") || fail_evidence current_deployment_logs "$?"
  if evaluate "$current_logs"; then
    (( SECONDS <= deadline )) || fail_evidence candidate_deadline 124
    cat "$evidence"
    exit 0
  fi
  if ! jq -e '.retryable == true' "$evidence" >/dev/null; then break; fi
  remaining=$((deadline - SECONDS))
  if (( remaining <= 0 )); then break; fi
  sleep "$((remaining < 10 ? remaining : 10))"
done
cat "$evidence"
exit 1
