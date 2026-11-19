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

## Command dispatch

Help and command discovery work before login and organization selection.
Native Docker host commands do not require an Armada API session. Interactive
session recovery can retry a command once after sign-in. API passthrough,
explicit login and logout, JSON mode, and explicit API tokens do not trigger
an interactive recovery prompt.

Global options are read only up to `--` to preserve prompt and command payloads.
Interactive launch discovery fills missing choices and leaves explicit placement
and agent choices to the usual validation.

For Boat and Modal snapshots, `snapshot update --add-repo` validates the
additions and appends on the server, preserving stored repositories and init
commands. On create or update, `--setup` reads a local file to send as setup
content. Use `--init` for literal initialization commands.

Sandbox `wait` and `exec` requests get the server budget plus 15 seconds of
transport grace. `send`, `stop`, and `bind-credential` use a 660-second
request deadline. That budget gives `send` time to restore paused compute
before admitting the turn. A transport timeout does not trigger a write retry.

## Organization resource commands

The CLI saves non-secret preferences, including the selected organization,
by Armada server origin in files separate from the saved session.

Invitation management resolves organization names through the authenticated
organization list. Pass acceptance tokens through stdin or `--file`. The CLI
omits rejected arguments from diagnostics and prints only approved invitation
fields, so extra response fields such as tokens and acceptance URLs stay private.

Select an organization with `armada org use` or `--org UUID` before using MCP
registry commands. Explicit CLI selectors take precedence over imported JSON
definitions. The server owns endpoint validation, discovery, and authorization.
For the sandbox connection list, the CLI sends both the public `sandboxId`
selector and the control handler's required `id`.

Routine schedules require both a cron expression and a timezone. The API
validates their values. A golden size-policy file replaces the entire policy.
The command prints the server's response, including its version and repository
selectors.

## Docker host commands and launches

Host names resolve within the selected organization through the host API.
Local host commands with an explicit server can select an instance even if
another server's daemon is unhealthy. If a registered daemon's server origin
cannot be read, inspect the instance with `armada host status` before retrying
installation. The new registration token remains unused.

The wrapper uses fixed failure diagnostics to keep native output and private
state out of CLI errors. See [Docker host installation and recovery](../../docs/docker-host-daemon.md)
for installation path checks, registration preservation, and service repair.

A plain-image Docker launch uses the Armada API without a golden or a Docker
provider credential. If the CLI reports an unknown outcome and prints a launch key,
retry with the same `--idempotency-key` and request body to recover the
original launch. Transport failures, uncertain server responses, and malformed
receipts can leave the outcome unknown.

## Login and session storage

Armada browser sign-in uses PKCE through the Armada server and keeps provider
details out of the CLI. Email links carry only a state-bound PKCE code. Sign-in
prefers email when the CLI remembers an address and email is enabled. Otherwise
it prefers an enabled browser method. The prompts for the sign-in method
and email address require an interactive terminal.

The saved Armada API session is local, holds no provider configuration and
uses file mode `0600`. Its login ID identifies the sign-in across token
rotations. The SQLite lock serializes session updates across processes and
releases on process exit, including a crash. It stores no tokens. Keep the
lock file in place because another CLI process may already have it open.

MCP connection authorization opens only a backend-issued HTTPS URL. After one
browser handoff, the CLI checks the requested connection's server-side status
before reporting success.

Native Codex model login runs in the foreground. The CLI withholds native
output and raw errors because provider responses may contain credentials. The
16-minute approval budget covers Codex 0.166's 15-minute device approval
window plus completion and authentication-file flush. The CLI checks the
initialization and login requests for errors, including connection-level
parse errors, and requires a matching login ID on completion. An import
requires a stable account ID for refresh and binding, even though native
Codex accepts a null ID. Temporary native credentials are removed during
cleanup.

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

## Sandbox command output

CLI diagnostics use “snapshot” terminology. API identifiers and JSON error
codes keep their original spelling.

For sandbox failures, HTTP 401 goes through shared login recovery. Other
failures use recognised codes or complete, fixed binding and policy messages.
Arbitrary provider and guest text stays out of diagnostics. The terminal list
renders the safe list response without looking up sandbox internals and
replaces control characters in labels and owners before displaying them.

After a successful Boat or Modal launch in text mode, the CLI looks up
optional resource advice with a two-second budget and quietly omits it when
the route or evidence is unavailable.

A closed stdout pipe ends the CLI with status zero, including during a follow
operation. Check a submitted mutation's outcome before retrying it. The exit
status in this case only describes the pipe.

## Local skill installation and hints

The installer preflights both agent destinations before writing. Exclusive
directory creation still refuses a destination created after that check. The
installer and hint use the same package name for the pinned public Armada skill.

The hint checks discovery roots in the home directory and up to 32 directories
starting at the working directory. Missing or unreadable installations do not
suppress the hint. The weekly cooldown also suppresses it when the receipt
timestamp is in the future after a clock rollback.

The CLI records the cooldown before printing. Unusable state suppresses the
hint, and errors in the hint leave the command's exit status alone. The receipt
is opened without following symlinks and in nonblocking mode, and the CLI
checks that the opened object is a regular file before truncating it. This
protects against a named pipe or other special file replacing the receipt
between the initial check and open.

## npm launcher and release checks

The npm and Bun installers select the compiled Armada binary through optional
dependencies constrained by operating system and CPU. The npm launcher runs
under Node or Bun and dispatches to that binary without a postinstall script.
The compiled-binary release check uses a local fixture API to verify that
account selection and launch defaults survive packaging.

## CLI test boundaries

Launch argument validation runs before network I/O. The launch API tests
cover request translation and preserve omitted, explicit, and empty values
for server-owned defaults. Credential and provider resolution are covered by
core and server launch tests. The CLI's golden-create request sends repository
and init configuration to a durable server-side build job, whose status the
CLI polls. Golden-list visibility is covered by the API and store tests.

CLI transport tests cover argv conversion, authenticated routing, and error
redaction. Server tests own authorization and lifetime policy. Template
replay uses the canonical template ID even if its name disappears after
admission. The scoped parity tests exercise the HTTP, auth, SQL, and registry
paths together for filtering, pagination, private-fork visibility, and
bindings. They also check that revoking membership invalidates org selection
before the next scoped read.

Native model login has separate tests for the Codex 0.166 JSON-RPC messages
and for the child-process JSONL and credential-file boundary. The synthetic
app-server peer runs locally without contacting a provider.
