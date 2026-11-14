# Snapshot maintenance discovery (#979)

This help-only slice adds focused discovery for existing maintenance commands:

```sh
armada snapshot connect --help
armada snapshot snapshot --help
armada snapshot remove --help
armada snapshot visibility --help
```

Each accepts `-h` and the legacy `golden` spelling. Exact command boundaries
only: names, IDs, option values and arguments after `--` retain operation parsing.
Help runs before login, files or network access.

Connect prepares the canonical master and prints its sandbox ID and available
web URL; it does not launch a browser. After maintenance, snapshot scans and
freezes that master. Do not leave secrets in it.

Remove accepts an unambiguous visible name or exact ID. Use provider and
organization selectors to disambiguate names. Visibility takes an ID, obtainable
from `armada snapshot list --json`, and `--visibility private|org`.
All operations still require Armada login and server authorization.

Offline discovery audit: 32 probes across four commands, two spellings, two flags
and no-session/fake-token modes; all fail before and succeed after with no
external requests. The regression is at run.ts's existing help boundary.
No provider, staging or interactive terminal evidence is claimed; this help-only
change uses the issue's audit exemption. Authenticated behavior is unchanged.
