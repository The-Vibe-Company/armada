# Upstream attribution and local changes

Source: https://github.com/alibaba/open-code-review/blob/v1.13.12/skills/open-code-review-delegate/SKILL.md
Release: v1.13.12
Commit: f921d6a0de3b71befce15d8edf589cd3609968fa
Author: Alibaba / open-code-review contributors
License: Apache-2.0 (see LICENSE)

The upstream body from the Workflow section onward is retained verbatim. Local modifications:
- Distribution frontmatter retains the review-code-dev package identity and description.
- Local introduction and Skillpack activation reporting precede the distribution setup.
- Distribution setup section added before the upstream workflow: portable checksum-pinned installation and caller handoff compatibility.
- Local Python bootstrap/test files and Skillpack metadata included.

No Alibaba affiliation or endorsement is implied by this repackaging. Package version is independent of the upstream CLI and skill metadata versions.

## Armada distribution changes

The upstream Alibaba workflow and Apache-2.0 LICENSE are retained.
Local bootstrap, tests and companion metadata from the source package are
MIT-licensed, Copyright (c) 2026 The Vibe Company (see LICENSE-MIT).
Imported package version: 2.2.0.

Armada adds a read-only `check` command to scripts/ocr.py, its offline tests,
and setup notes to SKILL.md. It checks the platform, cache permissions and
cached binary checksum without downloading or executing OCR.
