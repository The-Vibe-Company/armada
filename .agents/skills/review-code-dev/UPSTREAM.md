# Upstream attribution and local changes

Source: https://github.com/alibaba/open-code-review/blob/v1.13.12/skills/open-code-review-delegate/SKILL.md
Release: v1.13.12
Commit: f921d6a0de3b71befce15d8edf589cd3609968fa
Author: Alibaba / open-code-review contributors
License: Apache-2.0 (see LICENSE)

The upstream skill body is retained verbatim. Local modifications:
- Frontmatter name changed to review-code-dev to retain the existing package identity.
- Distribution setup section added before the upstream workflow: portable checksum-pinned installation and caller handoff compatibility.
- Skillpack runtime usage block added after frontmatter.
- Local Python bootstrap/test files and Skillpack metadata included.

No Alibaba affiliation or endorsement is implied by this repackaging. Package version is independent of the upstream CLI and skill metadata versions.

## Armada distribution changes

The upstream Alibaba workflow and Apache-2.0 LICENSE are retained.
Local bootstrap, tests and companion metadata from the source package are
MIT-licensed, Copyright (c) 2026 The Vibe Company (see LICENSE-MIT).
Imported package version: 2.2.0.
Skillpack source: [The-Vibe-Company/skillpack#91](https://github.com/The-Vibe-Company/skillpack/pull/91), commit `1de41e593ea1b539fb45125057d4c002241168a3`.

Armada adds a read-only `check` command to scripts/ocr.py, its offline tests,
and setup notes to SKILL.md. It checks the platform, cache permissions and
cached binary checksum without downloading or executing OCR.
