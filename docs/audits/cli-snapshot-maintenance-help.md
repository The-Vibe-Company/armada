# Snapshot maintenance discovery (#979)

This help-only slice adds focused discovery for existing maintenance commands:

```sh
armada snapshot remove --help
armada snapshot visibility --help
```

Each accepts `-h` and the legacy `golden` spelling. Exact command boundaries
only: names, IDs, option values and arguments after `--` retain operation parsing.
Help runs before login, files or network access.

Remove accepts an unambiguous visible name or exact ID. Use provider and
organization selectors to disambiguate names. Visibility takes an ID, obtainable
from `armada snapshot list --json`, and `--visibility private|org`.
All operations still require Armada login and server authorization.

Discovery is covered at the CLI help boundary without external requests.
