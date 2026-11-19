# Launch with Skillpack skills (#1007)

Open **Skills** in the snapshot launch form to add exact pins. After launch,
open **Skills** in the sandbox details to see its installation receipts. Use the
[template editor](template-skills.md) to save pins for template launches.

The picker reads the caller's connected workspace or the public catalog, showing
name, description, visibility and exact version. Search explicitly covers loaded
results; additional pages can be loaded. Select a skill, choose a published exact
version, then add it. Catalog failures do not block a plain launch: exact-pin
entry remains available. Missing/refused keys link to **What agents have → Skills**.

Selections are additions/overrides to the existing snapshot, organization, and personal
defaults, not a preview of all resolved defaults. Empty selections omit the
launch field. Server and browser share a browser-safe exact-pin policy; the
backend remains the installation/receipt authority. No key is passed to the
browser, and discovery does not install anything.

Stored receipts are read with the existing authorized sandbox detail data, not
through extra catalog requests. Private metadata-only viewers do not receive
receipt contents. Missing or malformed historical receipts are ignored; no
internal skill/workspace IDs are displayed.

## Checks and rollout

No migrations. Requires the catalog API slice (PR #1043); public browsing still
depends on Skillpack's existing anonymous catalog being enabled. Exact-pin entry
and private browsing are independent of public availability.

Coordinator staging: select a visible workspace skill/version and a public pin,
launch on Modal, inspect both receipts, then try a missing/revoked key.
Confirm selected skills remain editable after launch refusal and that a member
without sandbox interior access cannot see its receipts.
