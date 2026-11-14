# Service-token help (#979)

Focused help now covers `token create`, `token list` and `token revoke`,
with either help flag before authentication or I/O. Exact boundaries only:
IDs, labels and other operation arguments retain their parsers.

```sh
armada token create --org my-team --label automation
armada token list --json
armada token revoke TOKEN_UUID
```

Create prints a secret to stdout, including JSON mode. Store it securely when
created; Armada stores only its hash. Do not commit it or collect output in
public logs. Scripts use ARMADA_TOKEN through a secure environment, not argv.
Explicit organization selection overrides a saved selection for token creation.
List contains metadata and IDs, not token values. Revoke takes the ID, not
the secret. Authenticated operations retain server authorization.

Offline run.ts audit: 12 help probes across three leaves, two flags and
no-session/fake-token modes; all fail before and pass after with zero requests.
No token is created/revoked or secret value used. This help-only slice uses the
issue's live-audit exemption; no staging/provider/TTY evidence is claimed and
token behavior/output schemas are unchanged.
