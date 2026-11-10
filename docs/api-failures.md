# Actionable API failures

The control API keeps its existing `{"error":{"code":"…","message":"…"}}`
envelope. Clients should branch on the code, never diagnostic text.

| Code | HTTP | Client action |
| --- | --- | --- |
| `credential_refused` | 422 | Replace or reconnect the selected account before retrying. |
| `provider_unavailable` | 502 | Provider failed; try again later. |
| `dependency_unavailable` | 503 | Armada dependency unavailable; try again later. |
| `outcome_unknown` | 503 | Check operation/sandbox status before retrying: dispatch may have succeeded. |

These categories supplement existing validation, authorization and recorded
launch-failure codes; they do not replace them. MCP tools expose the same
categories as error codes. The shared contract lives in `@armada/core`.

This change does not add automatic retries, credential refresh, migrations,
or provider lifecycle redesign.
