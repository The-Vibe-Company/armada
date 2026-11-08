# Golden backend capabilities

The authenticated control API and MCP expose the configured provider's golden
limit without inspecting or modifying snapshots, builders, slots or database rows.
This is metadata, not a claim that legacy golden slots have been reconciled.

## Control API

`POST /api/v1/golden/capabilities`

Use the same bearer authentication as other control operations. The dashboard's
same-origin `/api/v1/golden/capabilities` proxy forwards this path and bearer.

```json
{"org":"<selected-org-id>","provider":"boat"}
```

Response (Boat's current provider contract):

```json
{"provider":"boat","maxGoldens":1}
```

`maxGoldens` is a nullable number read from the resolved provider instance;
`null` means unbounded or unknown, not zero. The response has no additional account,
credential, binding or slot fields and uses `Cache-Control: no-store`.

`org` is optional only when the authenticated caller has exactly one available org.
A scoped service/OAuth token cannot widen its org, even if its user belongs to others.
An explicit foreign org is denied before resolving a provider. `provider` defaults
to `boat`; unknown selectors and unavailable backends fail rather than falling back.
The dashboard should consume this response, not import a backend adapter or duplicate
its limits.

## MCP

`golden_capabilities` takes the same optional `org` and `provider` fields and returns
the same metadata as structured content. It is annotated read-only/non-destructive.
HTTP and MCP execute the same operation and selected-org/provider resolution.
