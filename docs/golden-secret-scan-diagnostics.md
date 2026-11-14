# Golden secret scan locations

A rejected golden build names the first available safe location, never the value:

    repository armada, git object <object-id>, commit <commit-id>

The build phase remains secret_scan. The curated location is persisted with the
durable job and appears in golden build-status, the CLI failure line and the
dashboard build error. Manual snapshot errors carry the same safe location.

## What is exposed

- Repository directory: selected by a bounded index into the requested/stored
  configuration, never a directory name supplied in provider output.
- Surface: file content, path name or Git object. Filenames themselves are not
  printed because a filename may be the matching secret.
- Git object IDs: full SHA-1 or SHA-256 hex identifiers only.
- Commit: the object itself for a matching commit, or a best-effort introducing
  commit for a blob. Blob lookup is capped at one second. Unreachable objects,
  unavailable Git features or an expensive lookup can omit the commit; rejection
  still names the object and remains fail-closed.

Only actual /home/user/<configured-directory> trees are attributed to a repository;
a same-named directory under /tmp or /root is not. Outside repositories, the
location stays explicitly outside the configured repositories. Existing bounded
surface/location-class counts remain in operator logs. Raw file contents,
filenames, provider stdout/stderr and unrecognized diagnostic records are not
copied into public messages.

The scan still inspects full history, including unreachable objects. A token-shaped
fixture removed from the working tree may therefore still reject the build when
its blob exists in history. No value allow-list, scanner exclusion, shallow-clone
default or history rewrite is introduced by this diagnostic change.

## Explicit per-repository short history (owner approved)

The owner approved a short-history checkout in #1755. Set this field on only the
repository whose old history is not needed:

```json
{
  "url": "https://github.com/The-Vibe-Company/armada.git",
  "branch": "main",
  "dir": "armada",
  "history": "shallow"
}
```

This is **one repository entry**, not the complete golden config. Preserve all
other repositories and init commands: `golden update --config` intentionally
replaces the full configuration and the CLI requires explicit `--replace`
confirmation. To derive the owner's complete current config
without dropping entries, after the updated CLI/server release:

```sh
armada golden list --provider boat --org <org-id> --json > goldens.json
jq -e '
  [.[] | select(.name == "two-repos-prod-test")]
  | if length == 1 then .[0].config else error("Expected exactly one Boat golden") end
  | if ([.repos[] | select(.dir == "armada")] | length) == 1
    then .repos |= map(if .dir == "armada" then . + {history: "shallow"} else . end)
    else error("Expected exactly one armada checkout directory") end
' goldens.json > golden.json
armada golden update two-repos-prod-test --provider boat --org <org-id> --config golden.json --replace
```

Review `golden.json` before the final mutating command. In the dashboard, open
Snapshots → Edit and rebuild and set **History → Latest commit only** on the
Armada row; other rows retain their modes. If a failed build is still tracked,
choose **New build request** first to use a fresh admission key. Existing stored modes survive editing
and additive updates; the immutable build request hash includes the field.

| Config | Boat / Modal golden | Docker host snapshot |
| --- | --- | --- |
| omitted | full single-branch history (unchanged) | existing shallow default (unchanged) |
| `"history": "shallow"` | latest commit only for that branch | latest commit only for that branch |
| `"history": "full"` | full single-branch history | explicitly full single-branch history |

Only selected shallow repositories receive `--depth=1 --single-branch`. No scan
logic, ignore-list or token exemption changes: every byte/object actually present
is still scanned. Old objects do not reach a fresh shallow clone, but a current
fixture still rejects. Deepening during init/setup can bring old objects back and
correctly fail again. Missing history can affect log/blame/bisect and
history-dependent version/build tools; later sandbox users can deepen explicitly.
Older CLI/server versions reject the unknown field rather than silently dropping
it. No history rewrite, migration or new CI job is required.

Tests/fixtures must not check in bytes matching real token patterns. Use short
underscore-separated placeholders; scanner-positive cases construct the synthetic
shape at runtime. The tracked-tree audit for this change found no remaining
matching literal fixtures; existing historical objects were not rewritten.

No production rebuild or migration was performed. The coordinator can retry the
same owner-approved build after release and report the repository/object/commit
location, then confirm the explicit history choice with that evidence.
