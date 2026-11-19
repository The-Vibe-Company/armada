# CLI API transport

The CLI uses `--url` before `ARMADA_URL` when choosing an explicit server.
`ARMADA_TOKEN` works without reading a saved login. A saved login binds its
credentials to one server, and older logins without a recorded origin bind to
the historical default. The server address must be an HTTP(S) origin.

Session refresh rereads the saved login under the shared session lock. This
lets concurrent CLI processes reuse credentials that another process already
rotated. The login identity and origin checks protect a login replaced while
the command was waiting for the lock. Older sessions may lack a login ID.

The request abort signal owns the API request budget. Bun's independent fetch
idle timeout is disabled so it does not cut that budget short.

Treat response diagnostics as untrusted. Vault writes, routine configuration,
sandbox interior operations and invitation errors can contain request data or
secrets. These paths select local diagnostics from recognised codes or fixed
sentinels. The transport recognises the `unknown_route` code and the fixed
provider-specific GitHub refresh refusal. Typed commands validate success receipts
before reporting success. Their control routes use JSON objects, including `{}`
for empty acknowledgements.
