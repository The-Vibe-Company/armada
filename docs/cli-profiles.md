# Named CLI profiles

Keep a production login and a staging login without replacing either:

```sh
# Existing unprofiled production login stays where it is.
armada --profile staging login --url https://armada-mcp-staging.up.railway.app --email you@example.com
armada --profile staging list
armada list

# Equivalent for a staging-only shell; a flag overrides this variable.
export ARMADA_PROFILE=staging
armada list
armada logout  # clears only staging's session
unset ARMADA_PROFILE
```

A profile remembers the server from its successful login. A new profile must
use `login --url SERVER` or `ARMADA_URL`; it never silently falls back to the
production server. For a saved profile, a different `ARMADA_URL` is refused
before sending its session. Log in to a different profile for another server.
Explicit `ARMADA_TOKEN` remains an override, not a profile secret: set its
matching `ARMADA_URL` yourself; it does not use the remembered login server.
Unset a globally exported token when you want to use a saved profile login.

`--profile NAME` / `--profile=NAME` is global and stops parsing at `--`, so put
prompt/command payloads after that separator. Names are case-sensitive, 1–64
ASCII letters/digits/underscores/hyphens, starting with a letter or digit.

Each named profile stores its session and organization/email/launch preferences
under `$XDG_CONFIG_HOME/armada/profiles/NAME/` (or
`~/.config/armada/profiles/NAME/`). Session file permissions and refresh locks
are unchanged. No credentials are copied or migrated. Without either profile
selector, existing files under `armada/` and existing CLI behavior stay intact.
A profile isolates local state; it is not an authorization or OS isolation
boundary. There is no profile-list/remove command in this initial slice.
