# Docker launch compatibility between releases (#1528)

## Staging regression and fix

Normal staging/source builds have a checked-in `null` image pin. They do not run
the release image publication/download job. Previously the pin getter threw, and
normal launch caught that configuration error as retryable `unavailable`, which
became HTTP 503 `outcome_unknown` despite no sandbox being allocated.

Until a source build carries a matching release pin, the server uses the existing
immutable `DOCKER_DEFAULT_IMAGE` bootstrap baseline (the same buildpack-deps digest
used before #1536). This is an explicit compatibility bridge, not a user image
choice and not an invented official GHCR digest. Published release pins stay
authoritative. A present but invalid/mismatched pin is never silently downgraded;
it produces a non-retryable, actionable `provider_not_configured` refusal before
allocation. The official-image transition still requires a published public GHCR
image and its matching generated pin. No per-PR image build is introduced.

The parity helper no longer sends its historical `image` configuration into normal
launch. The server alone chooses the image; older smoke configurations may retain
the unused field. Direct normal callers supplying `image` are still refused.

## Installed host compatibility

The tagged 2.27.0 daemon accepts the existing digest-pinned `create` and `bootstrap`
job shapes. #1536 did not change those wire shapes; it changed server image selection.
**No host upgrade is needed for this initial-launch fix.** A newer server version
alone is not grounds to reject an otherwise supported launch.

The `resume` job was added in 2.28.0. The 2.27.0 parser rejects that operation
before ACK, so sending it would strand a pending job. Normal resume now checks the
scoped host's reported daemon version before changing lifecycle state or queueing
work. Unknown/unreported or pre-2.28 hosts receive HTTP 409 with a plain instruction
to update, preserving registration. Current/newer compatible hosts still resume.
The old tagged daemon did not report version; that is treated conservatively for
resume, but not used to disable compatible initial launches.

For a **managed one-click host**, run the following as the Linux service owner to
upgrade from verified current staging bytes without a token or new registration:

```sh
(
set -eu
umask 077
server='https://armada-mcp-staging.up.railway.app'
case "$(uname -m)" in
  x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported architecture' >&2; exit 1;;
esac
tmp=$(mktemp -d "$HOME/.local/bin/.armada-host-upgrade.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl -fsS --proto '=https' "$server/api/docker-host/install.json" -o "$tmp/manifest.json"
digest=$(python3 -c 'import json,re,sys; d=json.load(open(sys.argv[1]))[sys.argv[2]]; assert isinstance(d,str) and re.fullmatch("[a-f0-9]{64}",d); print(d)' "$tmp/manifest.json" "$arch")
curl -fsS --proto '=https' "$server/api/runtime/artifacts/$digest" -o "$tmp/host"
printf '%s  %s\n' "$digest" "$tmp/host" | sha256sum --check --status
chmod 700 "$tmp/host"
"$tmp/host" upgrade --server "$server"
"$HOME/.local/bin/armada-docker-host" status
)
```

This deliberately does not follow redirects. The downloaded binary, not the old
installed binary, performs the managed upgrade, validating state/unit ownership
and preserving the host ID and credentials. A genuine manually installed tagged
2.27.0 host may lack managed ownership metadata: the command safely refuses that
case. Do not manufacture metadata, delete locks or re-register; use the existing
retained-host manual replacement procedure in `docker-host-daemon.md` instead.
No upgrade command or deployment was executed as part of this fix.
