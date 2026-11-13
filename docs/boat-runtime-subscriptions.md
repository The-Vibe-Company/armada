# Boat runtime subscription lifecycle

This slice addresses shared **Codex ChatGPT accounts** on the existing Boat
runtime path. It adds no launch option, exclusivity lock, sandbox-count limit or
native fallback. Claude tokens are not supported by Boat's currently Codex-only
runtime admission; this document does not claim Claude parity.

## Authentication boundary

Launch credential admission enrolls the selected account in the existing shared
subscription broker. Encrypted runtime configuration contains only the
`runtimeSubscription` marker, not a refresh token or stable native capability.
The guest requests access-only material using its current runtime bearer and
epoch. The server checks the sandbox/account/version and membership both before
and after broker refresh. Account renewal is persisted once server-side and
shared across guests. Replaced epochs cannot obtain new access material.

Native-writer migration must exclude `boat_runtime` guests during account
admission, turn repair and its final source recheck. Those guests are not legacy
refresh writers: probing or draining them through native SSH can interfere with
an active runtime and must not install the native stable-capability facade.
Native Boat and Modal migration remains unchanged.

## Offline evidence

`packages/mcp-server/test/subscription-migration.test.ts` reproduces the native
migration leak on the previous code and checks that runtime guests never reach
provider resolution/inspection, while the native migration cases still pass.

`packages/mcp-server/test/runtime-native-auth.test.ts` exercises the real SQL
broker, runtime access route and guest access callback together: two live guests
share an account, one rotates, the other's stale renewal reuses that committed
rotation, and a replacement epoch/server route reads the persisted token. The
old epoch refuses; the other guest remains usable. Refresh tokens stay outside
access responses and the journal. This is not real model-inference evidence.

## Single coordinator staging check

No worker deploys, applies migrations or allocates Boat compute. After normal
deployment, use the existing combined smoke with an authorized **ChatGPT-backed
Codex account UUID** as `ARMADA_RUNTIME_CREDENTIAL_ID`. Confirm the selected
account's kind is `codex_auth` in the account inventory before the check; an
API-key account does not establish subscription acceptance. All other existing
origin/login/org/golden/MCP/GitHub inputs remain unchanged; skill defaults must
already be configured.

On a revision also containing the usage slice (#1418), run exactly once:

```sh
ARMADA_RUNTIME_SMOKE=one_real_boat_launch \
  bun scripts/check-boat-runtime.ts --usage --skills --mcp --github --resume
```

This reuses the one allocation and one same-VM resume lifecycle, not an extra
subscription allocation. Require actual archived answers before and after
resume and the existing usage checks. A successful answer proves access for
this subscription account, **not necessarily a real refresh**: refresh acceptance
also needs coordinator evidence of a server-side revision advance, without
printing tokens. An unknown cost is not cost parity. #1420 remains open until
positive cost, subscription-backed answers/refresh, and the requested Claude
token support are accepted; neither this repair nor #1418 alone closes it.
