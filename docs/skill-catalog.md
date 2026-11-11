# Skillpack discovery API (#1007)

Authenticated POST `/api/v1/skillpack/catalog`:
`{"org":"ORG_UUID","source":"public","offset":0}`.
Returns `{items,nextOffset}` (50 items per page). Each item contains only
`reference,name,description,visibility,versions`. Versions are exact; combine
`reference + "@" + version` to select an install pin.

POST `/api/v1/skillpack/versions`:
`{"org":"ORG_UUID","source":"private","reference":"notes"}`.
Returns `{versions}`; public references are `org/slug`, private ones bare slugs.
Unknown fields, query parameters and arbitrary registry/workspace overrides are refused.

Discovery uses the same personal-over-org Skillpack credential policy as launch.
Private means authenticated workspace access (including accessible personal and
organization libraries), not a claim about Skillpack's own library scope.
Current Armada membership and bearer org scope are checked before requests;
membership is checked again before returning metadata. Keys stay server-side.
There is no per-user/global result cache, and API responses are no-store.

## Upstream investigation

Read-only inspection of Skillpack's own API routes/contracts and CLI:
- `GET /v1/public/catalog/skills?limit=50&offset=N`: anonymous, paginated.
- `GET /v1/public/catalog/skills/ORG/SLUG`: anonymous; **one currently
  published public version**, not arbitrary private history.
- `GET /v1/skills?lib=accessible`: bearer PAT, `skills:read`; accessible
  organization and personal skills. No upstream pagination, so Armada bounds
  the response and paginates its projection locally.
- `GET /v1/skills/SLUG/versions`: bearer PAT; validated exact workspace versions.

No Skillpack changes, Armada headers, database access or key-bearing URLs.
Private metadata (frontmatter, storage paths, share tokens, creator identities)
is deliberately not forwarded. Redirects are refused; response/time bounds
prevent unbounded downloads. An invalid/revoked personal key never silently
falls back to an org key.

The anonymous catalog is feature-gated by Skillpack. An anonymous read-only
probe on 2026-11-11 returned HTTP 404 at the canonical origin. Armada reports
catalog unavailable rather than inventing an empty catalog; consumers must
offer exact-pin entry and keep the private workspace independently usable.
Do not equate listing with install authorization: the existing installer and
verified receipts remain authoritative.

No migrations. No staging credentials used. Coordinator staging: browse a
connected workspace, compare names/versions to Skillpack, choose and launch
an exact public/private pin, revoke key/membership and confirm safe refusal.
Public discovery requires Skillpack's existing catalog endpoint to be enabled;
no Armada-specific change is required there.
