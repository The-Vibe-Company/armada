# Default skill pins — API slice (#1007)

Defaults are non-secret exact Skillpack pins, not packages baked into a golden.
They install on each new sandbox through the existing public/private installer,
under the launching user's Skillpack key (personal key, else organization key).
They do not apply retroactively on send/resume or modify the golden snapshot.

## Management API

Authenticated POST under `/api/v1/skills/defaults/get` or `set`.
MCP equivalents: `skill_defaults_get`, `skill_defaults_set`.
Bodies are strict JSON; query parameters are rejected.

```json
{"org":"ORG_UUID","scope":"personal","skills":["notes@1.0.0"]}
```

`set` replaces the whole list, `skills: []` clears it. `get` omits
`skills`. Both return `{"skills":[]}` when empty. Scopes:
- `personal`: global to this user across organizations; current membership in
  the selected organization is still required to manage or launch.
- `org`: members read; only current admins write.
- `golden`: also requires `goldenId`; visible golden access to read, owner
  to write private goldens, admin to write organization goldens. Admins cannot
  see another user's private golden. Removed goldens cannot be managed.

User JWTs have read-only table grants, never direct writes. Server operations
recheck live membership/visibility, not just bearer claims. Lists accept at most
20 distinct slugs with exact versions, public `org/slug@version` or private
`slug@version`; no floating `latest`.

## Launch resolution

Low to high priority:

1. Environment/golden defaults
2. Organization defaults
3. Personal defaults of the launching actor
4. Template revision pins, for template launches
5. Explicit launch `skills`

Identity is the final slug before `@`, not the catalog or version: public
`team/notes@1.0.0` and private `notes@2.0.0` collide. A later layer replaces
the whole pin for that slug. Each layer must itself be valid and have distinct
slugs; the final merged list must also have at most 20. Surviving slugs install
in first-seen order, with the winning pin substituted in place. Over-limit
merges fail before allocation; they are never silently truncated.

Set `skipSkillDefaults: true` on HTTP launch or MCP `launch`/`launch_sized_v1`
or `template_launch` to exclude layers 1–3 for this launch only. Template and
explicit pins still install. This is a boolean, not a string.
Example template launch:

```json
{"org":"ORG_UUID","id":"TEMPLATE_UUID","requestKey":"one-launch",
 "skipSkillDefaults":true,"skills":["notes@2.0.0"]}
```

Template admission freezes the effective list as `manifest.resolvedSkills`
without changing `manifest.definition.skills`. It is read inside the claim
transaction; installation and same-key retries never reread mutable defaults.
Historical manifests without this field use only their frozen revision pins.
Completed `manifest.skillReceipts` and sandbox receipts show verified installs.
Ordinary launches resolve once before allocation. Defaults lookup failure is
fail-closed; opt-out deliberately needs no defaults lookup. Private key refusal,
cleanup and no-prompt-on-install-failure use the existing installer semantics.

## Migration / coordinator staging checks

Apply `20261111160000_skill_defaults.sql` through the normal deployment
process before running the new server. Workers do not apply it to staging or
production. No new credentials or Skillpack changes are needed.

On **Boat and Modal**, coordinator:
1. Set a personal and golden default, plain-launch and inspect both receipts.
2. Add conflicting org/personal/template/explicit versions of the same slug;
   verify the documented winner, including a public/private slug collision.
3. Launch with opt-out: only template/explicit pins remain; saved defaults
   unchanged. Clear a scope with `[]` and confirm the next new launch.
4. Template launch, change defaults, replay same key after restart: identical
   frozen effective list/receipts, no new install or sandbox.
5. Missing personal and org Skillpack key with private defaults: existing readable
   missing-key refusal, no prompt. Admin/member/private-golden access checks.
6. More than 20 effective distinct slugs: refusal before allocation.

CLI and dashboard controls remain separate follow-up PRs. No orchestrator
behavior is added.
