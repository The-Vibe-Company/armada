# MCP launch selection v1

Source: packages/core/src/mcp-launch-selection.ts, exported from @armada/core.
The browser-safe mcpLaunchSelection(available, explicit?) returns { ids, blockedIds }.
Candidates MUST come from the actor-authorized connection list for the selected org.
It is a selection preview, never an authorization primitive.

- Omitted connections snapshots all enabled defaultForLaunch IDs, personal and org.
- Explicit [] (--no-connections) opts out. Explicit IDs (--connections) replace defaults.
- Disconnected defaults stay in ids AND blockedIds. Block launch until reconnect or a
  deliberate explicit subset/empty selection. Do not silently filter them out.
- Disabled defaults are excluded. Explicit disabled IDs block.
- Scope remains personal; no copying, sharing or impersonating grants.
- Legacy sandbox visibility has no bearing on this selection.
- Existing bindings never expand after metadata/default changes.

Dashboard compatibility: replace the old launchBlocker personal/org restriction.
launchDefaults currently drops disconnected defaults; do not use that result as an
explicit override on untouched submit. unreadyDefaults must include personal defaults
regardless visibility. Use omission until deliberate selection, or submit the complete
snapshot after checking blockedIds. Golden source visibility remains separate.

Deployment: drain all launch/native-turn/lease-renewal writers and gateway replicas
before applying migration 20261110121200 and deploying the matching application.
Old replicas silently omit personal defaults for org sandboxes and reject owner
bindings/renewal: mixed-version service is unsupported, not a safe fallback.
Resume traffic only after sibling sandbox authorization migration/application and
this migration/application are installed together. No production operations performed.

Authority: same org, personal connection owner equals sandbox owner, and current
owner membership. Admin sandbox interior access never changes the grant owner.
Admins with arbitrary guest exec can observe guest config/lease material; this
policy protects control-plane personal grant APIs, not secrecy from privileged guest
execution. Do not represent metadata access as grant or gateway authority.
