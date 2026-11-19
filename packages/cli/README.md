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

## Vault input and output

Application variables and secrets use separate commands from model-account
credentials. Supply values through stdin or `--file`, since command arguments
can end up in shell history. The interactive secret prompt suppresses echo,
including readline redraws.

Application vault writes read the value before contacting the API. Input
errors omit file paths, file contents, and rejected arguments because each
could contain a secret. The CLI selects approved scalar metadata fields from
list and write responses. Only an explicit variable read prints a value.

Native model login obtains consent locally before import. The CLI sends the
credential to the Armada API and prints a fixed confirmation after the write.
