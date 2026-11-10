## Investigation and proposed design (before implementation)
Read Armada's bootstrap/runtime/store/CLI/serve composition and Skillpack's `runtime/internal/cli/{install,public,auth}.go`, `docs/skillpack-cli.md` and runtime docs; Skillpack is read-only in this ticket.

- Native `skillpack install org/slug --version X --scope project --project DIR --tools codex,claude-code --json` installs anonymous catalog releases. Catalog fetches send no saved or environment credentials, verify the frozen ZIP checksum and identity, and only accept the currently advertised validated version. The project lock is `.companion/skills.lock.json`, with `catalog:org` workspace, slug, exact version, skill UUID and checksum; managed host discovery copies are installed. No package scripts execute.
- Private workspace installs use slug/UUID and a workspace-bound profile or ephemeral `SKILLPACK_API_KEY` (never argv). Armada currently delegates Armada/model/GitHub authority, not Skillpack auth. Private installation cannot safely be promised without a separate credential contract. Public share-token installation also requires an authorized API key; it is not anonymous catalog installation.
- Small first slice: one optional `skill` = public `org/slug@exact-version`, exposed by CLI/API/MCP and persisted configuration. Require the native Skillpack CLI in the golden only when selected; no downloaded bootstrap script or control-plane package execution. Install before authority/first turn, validate lock identity/version/checksum, persist a public receipt, fail closed with sanitized errors. Exact pins avoid version drift on resume. Unversioned defaults/private/custom-origin support are follow-ups, not implicit fallback.
- No skill means a plain harness with a minimal Armada-owned tool reference, not armada-manager. The old revision setting becomes deprecated compatibility metadata, not an orchestration-method selector.
- Skills are untrusted instructions: they can execute commands/read parent credentials and consume delegated launch authority. Armada still confines delegation to the owner/org, owned children, expiry and active-child limits; it cannot guarantee a method is benign. Pins prove identity, not safety.
- Migration plan: publish The Vibe Company's armada-manager plus its coordinator-review references (#831) into Skillpack, validate both harnesses, then remove repository copies. Do not modify ship-pr-dev or armada-manager here. Dashboard/iOS pickers, defaults, private auth and removal/publication tracked separately.

## Delivery
Public catalog pins are implemented. Follow-ups: #840 (dashboard/iOS), #841
(defaults and credential/origin design), #842 (publish and remove repository method).
The reserved `armada-tools` slug is refused to keep package and launcher knowledge separate.
Installation occurs on create, not on resume; disk continuity retains the installed pin.

## Real-provider verification
Coordinator staging check (not performed here): use a golden with the released native Skillpack CLI; create with a public catalog `--skill org/slug@version` for Boat Claude/Codex and Modal Codex; inspect detail receipt and ask the first turn to identify/read the installed skill. Verify a missing release blocks create without a first turn. No deployment or production access in this PR.
