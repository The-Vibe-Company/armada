import { type GoldenRepo, pushLedgerInstall } from "@armada/core";

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Prepare explicit Docker repositories before allowing the first prompt. */
export function dockerRepositoryCheckout(repos: readonly GoldenRepo[], root: string): string {
  return [
    "set -euo pipefail",
    "export GIT_TERMINAL_PROMPT=0",
    `checkout_repository() (
  url=$1
  branch=$2
  destination=$3
  # This fetches the remote default and records its tracking ref in one trip.
  git clone --depth=3 --single-branch --no-checkout -- "$url" "$destination"
  cd "$destination"
  default_ref=$(git symbolic-ref HEAD)
  launch_ref="refs/heads/$branch"
  if [ "$launch_ref" = "$default_ref" ]; then
    git checkout --force "$branch"
    exit
  fi

  default_tracking="refs/remotes/origin/\${default_ref#refs/heads/}"
  launch_tracking="refs/remotes/origin/$branch"
  for depth in 3 32 128 512; do
    filters=()
    # Both tips are already available after the first round. Fetch commit history cheaply.
    if [ "$depth" -gt 3 ]; then filters=(--filter=tree:0); fi
    git fetch --no-tags --depth="$depth" "\${filters[@]}" origin "+$default_ref:$default_tracking" "+$launch_ref:$launch_tracking"
    if git merge-base "$default_tracking" "$launch_tracking" >/dev/null; then
      git config --add remote.origin.fetch "+$launch_ref:$launch_tracking"
      git switch --track -c "$branch" "$launch_tracking"
      exit
    fi
  done
  printf '%s\\n' 'Could not establish a merge base with the default branch within 512 commits.' >&2
  exit 1
)`,
    // Pushes of new branches must update origin tracking refs for the push ledger.
    `track_pushes() (
  cd "$1"
  git config --local --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
  ${pushLedgerInstall}
)`,
    ...repos.flatMap((repo) => {
      const destination = quote(`${root}/${repo.dir}`);
      return [
        `checkout_repository ${quote(repo.url)} ${quote(repo.branch)} ${destination}`,
        `track_pushes ${destination}`,
      ];
    }),
  ].join("\n");
}
