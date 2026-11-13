# Docker application-secret bindings

Normal Docker launch accepts `secrets: [{key, secretId, version}]`, or the existing
CLI reference syntax `--secret APP_TOKEN:UUID:VERSION`. Values must be managed
through the application vault's private stdin/file upload flow; never pass secret
values in launch arguments, prompts or config files. Bindings may not overlap
readable-variable keys or target reserved model/provider/loader/frontend-public
keys. Combined limits remain 64 keys, 8 KiB per value and 64 KiB total.

Docker and templates use the same core reference parser and resolver. Admission
checks membership, personal/org scope, active status, expiry and exact version;
the combined decrypted environment is validated before allocation commits.
Only references enter the launch manifest/response. Plaintext is transient and
sent through the existing encrypted runtime command transport to the selected
native harness, not host jobs, image layers or ordinary exec/init environment.

Readable values stay frozen. Secret references are re-resolved for each new turn
and resumed-runtime environment preparation. Source-member, secret-reference and
runtime admission locks protect enqueueing the configuration; no transaction is
held while waiting for the runtime. Revoke, expiry or rotation refuses new
preparation. Completed prompt retries reconcile their durable receipt without
requiring the secret to remain available or admitting another prompt.

This extends the existing owner-approved **raw-delivery** path from Boat/Modal.
It adds **no taint marker, secret-safe logging/recovery/snapshot/retention,
erasure or confidentiality guarantee**. The selected agent, children,
same-UID/root users and host operators can read/copy/exfiltrate delivered values;
revocation cannot erase a prior or already-admitted delivery. Rotate upstream
credentials after exposure. Existing irreversible taint guards remain unchanged;
this slice must not manually taint workloads or imply that future Docker
builder images may contain launch secrets. See `templates-cli.md` for the shared
raw-delivery limits.

`launch/options` adds optional `capabilities.secrets`. The shared core capability
contract and dashboard parser accept it; older-server absence means unsupported.
No new provider/harness/status enum values or driver-specific delivery path.

## Coordinator's single real-host check

Use a dedicated existing application-secret canary/version authorized to the
launch owner on host `70bde9cd-36c9-40af-b15e-65b2f9d3c2a2`. Set
`ARMADA_DOCKER_SECRET_SHA256` to its UTF-8 value's lowercase SHA256 digest outside
the model prompt; never provide the raw value to this script. Keep ARMADA_TOKEN
in the environment. With existing server/org/account/SSH/digest-image inputs:

```sh
python3 scripts/smoke-docker-lifecycle.py \
  --server "$ARMADA_URL" --org "$ARMADA_ORG" --credential "$ARMADA_CREDENTIAL_ID" \
  --ssh "$ARMADA_DOCKER_SSH" --host-id 70bde9cd-36c9-40af-b15e-65b2f9d3c2a2 \
  --image "$ARMADA_DOCKER_IMAGE" --repository The-Vibe-Company/armada --branch main \
  --github --normal-lifecycle \
  --secret "APP_TOKEN:$ARMADA_DOCKER_SECRET_ID:$ARMADA_DOCKER_SECRET_VERSION"
```

One allocation: Git/gh and retained-memory proofs plus successful archived
native SHA256 command results at initial/follow-up/resumed turns. Expected digest
never enters the model prompt; missing/wrong-digest proof fails. The script asks
for a digest, never plaintext, but raw native access is not a general leakage
defence. The evidence matcher currently requires Codex, explicitly refusing
Claude/OpenCode combinations. This is a procedure, not a real-host pass.

Stacked on the readable-variable slice. No migration, deployment, production
access, real-host action or manual runtime publication is performed by this PR.
Host-local Docker environment image builds remain the next #1464 slice;
Boat/Modal goldens stay provider-specific and are not Docker-reusable snapshots.
