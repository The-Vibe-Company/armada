# Issue #2506 design findings

Root presentation cause: Routines was squeezed into generic resource cells with count and footnote; its create form was a sentence, rather than the prototype's named fields. Organization retained redundant resource navigation and roster explanatory copy absent from prototype. Login input used default 36px rather than 40px.

Gaps backed by existing contracts:
- Routines list DTO has no last-run summary; history loads only on demand. Last run column opens that history (See runs), avoiding one network request per visible routine.
- Current dashboard creation uses interval hours and pins the template revision; prototype cron presets, timezone selection, GitHub-release trigger, edit and Run now are not supplied by the existing dashboard contract. Kept interval scheduling, immutable visibility, task, TTL and daily safety cap reachable. Did not invent prototype behaviors.
- Member RPC supplies email and role, not display name or last activity; preserved email identity, explicit role selection/save, self-demotion confirmation and removal confirmation.
- Prototype Organization includes service tokens; current tokens are managed through their existing dedicated screen. No duplicate owner controls added here.
- Prototype Your connections sessions list and accent switching lack existing dashboard session-management/accent contracts; kept GitHub installation management, personal provider keys, Models link, and device theme controls.
- Prototype contains no distinct first-run screen reachable from its current sign-in flow; existing organization/setup first-run journey remains intact.
- Shared shell places page actions in top chrome, while prototype has in-page header actions. This change does not modify shared shell primitives.

Launch settings expand inline instead of floating menus. Visibility follows the existing private launch policy. Organization templates are offered only by the snapshot launch entry point that already supplies them; the global composer does not yet load templates. Blocked-launch comparison pairs remain outstanding.
