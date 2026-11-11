# Connect Skillpack — proposal and delivery slices (#1008)

## Two-minute design

Click path: **Build > Skills > Connect Skillpack** → Skillpack sign-in → consent
showing the requesting application, selected workspace and exact read/install
permissions → return to Armada with “Connected”. Denial leaves the old credential
untouched. This is a proposal, not an enabled button in this slice.

Prefer an authorization-code + S256 PKCE flow that issues a **delegated,
workspace-bound, read/install-only credential** usable by the native Skillpack CLI.
Do not repurpose the existing MCP OAuth grant: it has session-equivalent rights
and a `/mcp` audience, not the CLI API-key contract. Never silently create a broad
personal API key on consent. Skillpack knows only generic registered clients,
redirect URIs, permissions and workspaces; no Armada-specific branches or branding.

Start with personal Armada storage. The consenting user's Skillpack workspace is
not an Armada organization. An explicit later “share with organization” action
requires a current Armada admin and a warning that launches by other members will
use that identity. User credentials continue to override org defaults.

Armada stores the resulting credential through `setCredential` (`skillpack`),
using existing AES-256-GCM encryption and `ARMADA_ENCRYPTION_KEY`; never in a golden.
Reconnection replaces it only after a successful exchange and authorization check.
Skillpack lists/revokes each delegated grant. Removing an Armada credential stops
future use there but is **not** remote revocation; disclose that distinction.
Rotation must invalidate the replaced grant, with explicit recovery if revocation
fails; short-lived/refresh tokens require a separate encrypted lifecycle, not
putting an expiring MCP access token into the static API-key slot.

## Investigation (source, not production verification)

Read-only inspection of `The-Vibe-Company/skillpack`, commit
`0388e368073cb795fe60eee0afc8d8cb2d929412`:

- `apps/web/src/components/org/SettingsApp.tsx` calls `issueTokenRpc({name})`;
  `ApiKeysPane.tsx` describes personal keys carrying the user's access. Creation
  returns a one-time token; listing and revocation already exist. This is not a
  delegated, read-only installation grant.
- `docs/design.md` documents OAuth 2.1 under `/auth/oauth2/*`, dynamic client
  registration, S256 PKCE, consent, workspace pinning and refresh rotation.
  Discovery: `/.well-known/oauth-authorization-server/auth`. Existing MCP OAuth
  has session-equivalent rights and `/mcp` resource audience.
- `apps/api/src/agentAuthRoutes.ts` implements device capability approval; it is a
  separate capability model, not evidence that native CLI installation accepts
  that bearer. Neither device auth nor MCP consent should be assumed compatible.
- No supported delegated-key redirect/deep-link contract was established by this
  investigation. Do not construct a settings URL that returns a raw key.

## First Armada slice (this PR)

Authenticated `POST /api/v1/skillpack/connection`, body `{}` or `{ "org": "id-or-name" }`,
returns `authorization: { available: false, reason: "delegated_key_flow_unavailable" }`,
plus `user` credential metadata and visible `orgs` with only Skillpack metadata.
It uses the existing vault's live membership rules and service-token org scope.
No key is read/decrypted, no remote request occurs and no connection is created.
Credential presence is not a remote validity/health check. Existing manual
`creds/set` and `creds/rm` remain the write path. The future UI must not offer a
working connect action while authorization is unavailable.

No migrations, provider config, deployment or staging credentials are required.
This slice intentionally does not implement a speculative callback or token exchange.

## Next PRs

1. Coordinator: agree and deliver the generic Skillpack contract below in its own repo.
2. Armada API: durable, expiring, one-use connection attempts; PKCE exchange;
   encrypted credential persistence; revocation/rotation and recovery; enable the
   capability only when configured. No orchestrator dependency.
3. Armada dashboard: Connect/Cancel/Reconnect states in Build > Skills, callback
   result UX, optional admin-only org sharing, and end-to-end coverage.

## Ready-to-file Skillpack issue (proposal only)

**Title:** feat(auth): authorize third-party CLI installation credentials

**Need:** A registered third-party application can request a workspace-bound
read/install grant without copying a personal key. Keep this generic; no
application-specific integration code.

**Contract to agree before implementation:**

- Reuse standard authorization-code/S256 infrastructure where possible, but use
  a distinct CLI resource audience and explicit least-privilege read/install scopes.
  Specify exact endpoints, scopes, token format, expiry and CLI compatibility.
- Exact registered HTTPS callback URIs; no wildcard/open redirects or implicit
  flow. Consent shows verified client identity, workspace, rights and expiry.
- Server-to-server exchange returns the CLI-compatible credential only in a
  no-store JSON response. URLs carry only short-lived codes and state, never keys.
- Single-use codes bound to client, callback and PKCE; expiry and replay rejection.
  Never grant broader rights on unsupported scope; deny instead.
- List/revoke grants individually, rotate safely, enforce current workspace
  membership and publish explicit revocation/rotation semantics.
- Document refusal, denial, replay, expired-code and revoked-grant responses.
  Test public/confidential clients, cross-workspace access and CLI install using
  only the granted permissions. No permission to publish, administer or read secrets.

**Armada consumer threat model:**
Bind random state + PKCE verifier to the initiating signed-in user, session,
intended storage scope and fixed callback with a short durable TTL. Consume state
atomically; reject mismatched sessions, replay and unsolicited callbacks. Recheck
membership/admin rights at completion. Never accept caller-chosen issuer, token
endpoint or return URL (SSRF/open redirect). Keep browser callback redirects on
an allowlist; codes/state and token bodies must be excluded from access logs,
telemetry and error messages. Use no-store/referrer-policy and immediately clean
the callback URL. Denial, timeout and failed exchange must not overwrite a key.

## Coordinator staging checklist (not run by this worker)

- Confirm deployed Skillpack contract and native CLI compatibility, scopes,
  audience, expiry, membership loss and revocation; local source is not proof.
- With a personal session, read the new endpoint before/after manual key setup;
  ensure responses contain metadata only and other credential kinds are absent.
- Verify org filters, stale membership and service-token org confinement.
- After follow-up API/UI work: consent allow/deny, session mismatch, expired and
  replayed callbacks, malicious redirect/issuer, exchange failure, safe reconnect,
  org admin loss, remote revocation and rotation. Inspect logs for secret leakage.
