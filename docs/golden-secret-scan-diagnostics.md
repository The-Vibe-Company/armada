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

## History policy needs an explicit owner decision

For the known already-public fake fixture in #1755, a per-repository history mode
has been proposed in the [issue design comment](https://github.com/The-Vibe-Company/armada/issues/1755#issuecomment-6875196321).
It is not implemented or accepted as configuration by this PR. The proposed mode
would be explicit and visible, preserve full history by default, and apply only
to the chosen repository. Missing history affects blame/log/bisect and
history-dependent builds; later deepening (including init scripts) can reintroduce
the matching object. Scanning every byte/object actually present would remain
unchanged. Docker host snapshots currently have a separate globally shallow
checkout policy; a unified history field must explicitly preserve or migrate that
default rather than silently deepen it. Do not retry an undocumented override or
infer that a public match is safe to ignore.

Tests/fixtures must not check in bytes matching real token patterns. Use short
underscore-separated placeholders; scanner-positive cases construct the synthetic
shape at runtime. The tracked-tree audit for this change found no remaining
matching literal fixtures; existing historical objects were not rewritten.

No production rebuild or migration was performed. The coordinator can retry the
same owner-approved build after release and report the repository/object/commit
location, then make the history-mode decision with that evidence.
