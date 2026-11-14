# Native credential discovery (#979)

Native credential help now covers `creds login`, `creds login codex`,
`creds import`, `creds import claude` and `creds import codex`, with
both help flags before authentication or I/O.

```sh
armada creds login codex --name personal
armada creds import claude --name personal --file /private/native-credential
armada creds import codex --id ACCOUNT_UUID --expected-version 2 --file /private/native-auth.json
```

Login starts Codex device authorization; keep the parent terminal open until
publication completes. Claude instead uses a locally obtained setup token and
import. Import never starts native login. Provide credentials through private
files or stdin/hidden input, not command arguments. Do not commit these files.
Replacement requires the account ID and a positive integer expected version;
new accounts require a name. Omit organization for personal scope.
The imported account is encrypted; allowance information may be unavailable.

Offline run.ts audit: 20 probes across five help paths, two flags and
no-session/fake-token modes. Before, only the four existing Codex leaf-help
probes succeed; after, all 20 succeed. No network, native login or secret input.
This help-only slice uses the issue's live-audit exemption; authenticated
operations, import validation and storage are unchanged.
