#!/usr/bin/env bash
# Run from the repository root after staging dist/npm and dist/tarballs.
set -euo pipefail
: "${VERSION:?VERSION is required}" "${DIST_TAG:?DIST_TAG is required}" "${PUBLISH:?PUBLISH is required}"

newly_published=" "
dry=()
if [ "$PUBLISH" != true ]; then dry=(--dry-run); fi

publish_package() {
  local name=$1 tarball=$2
  if [ "$PUBLISH" = true ] && npm view "$name@$VERSION" version --prefer-online > /dev/null 2>&1; then
    echo "$name@$VERSION is already published."
    return
  fi
  npm publish "$tarball" --access public --tag "$DIST_TAG" --provenance ${dry[@]+"${dry[@]}"}
  newly_published+="$name "
}

tarball_for() {
  echo "dist/tarballs/$(echo "${1#@}" | tr / -)-$VERSION.tgz"
}

# Publishing success does not mean the registry can serve the binary yet.
for dir in dist/npm/armada-*/; do
  name=$(jq -r .name "$dir/package.json")
  publish_package "$name" "$(tarball_for "$name")"
done

if [ "$PUBLISH" = true ]; then
  wait_seconds=${NPM_PUBLISH_WAIT_SECONDS:-300}
  poll_seconds=${NPM_PUBLISH_POLL_SECONDS:-5}
  if ! [[ "$wait_seconds" =~ ^[0-9]+$ && "$poll_seconds" =~ ^[0-9]+$ ]]; then
    echo "NPM_PUBLISH_WAIT_SECONDS and NPM_PUBLISH_POLL_SECONDS must be integers." >&2
    exit 1
  fi
  wait_seconds=$((10#$wait_seconds))
  poll_seconds=$((10#$poll_seconds))
  if [ "$poll_seconds" -eq 0 ]; then
    echo "NPM_PUBLISH_POLL_SECONDS must be positive." >&2
    exit 1
  fi
  registry_dir=$(mktemp -d)
  trap 'rm -rf "$registry_dir"' EXIT
  started=$SECONDS
  waited=0
  for dir in dist/npm/armada-*/; do
    name=$(jq -r .name "$dir/package.json")
    tarball=$(tarball_for "$name")
    while true; do
      # Share one retry budget across all platform packages. Account for registry
      # request time as well as sleep time; zero permits one immediate attempt.
      elapsed=$((SECONDS - started))
      if [ "$waited" -gt "$elapsed" ]; then elapsed=$waited; fi
      remaining=$((wait_seconds - elapsed))
      fetch_timeout=$((remaining > 0 ? remaining * 1000 : 1))
      if npm pack "$name@$VERSION" --ignore-scripts --prefer-online \
        --fetch-retries=0 --fetch-timeout="$fetch_timeout" --pack-destination "$registry_dir"; then
        # Recovery rebuilds can differ from the immutable original release.
        # Compare bytes only when this invocation uploaded the staged tarball.
        if [[ "$newly_published" = *" $name "* ]] && ! cmp -s "$tarball" "$registry_dir/$(basename "$tarball")"; then
          echo "Registry tarball for $name@$VERSION differs from the staged artifact." >&2
          exit 1
        fi
        break
      fi
      elapsed=$((SECONDS - started))
      if [ "$waited" -gt "$elapsed" ]; then elapsed=$waited; fi
      remaining=$((wait_seconds - elapsed))
      if [ "$remaining" -le 0 ]; then
        echo "Timed out waiting for registry tarball $name@$VERSION; launcher publication refused." >&2
        exit 1
      fi
      delay=$poll_seconds
      if [ "$delay" -gt "$remaining" ]; then delay=$remaining; fi
      echo "Waiting for registry tarball $name@$VERSION ($remaining seconds remaining)."
      sleep "$delay"
      waited=$((elapsed + delay))
    done
  done
fi

name=$(jq -r .name dist/npm/armada/package.json)
publish_package "$name" "$(tarball_for "$name")"
