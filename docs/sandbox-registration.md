# Server-owned sandbox registration

Physical sandbox identities are registered only by the trusted Armada server,
after an authorized launch forks the selected golden. This applies equally to
Boat and Modal. The shared SQL sandbox store must use a server database
connection with the service role; a user-JWT connection cannot register rows.

Deploy migration `20261110110000_server_owned_sandbox_registration.sql` before
accepting browser traffic. The current API-only CLI, dashboard and MCP launch
paths already use server registration, so no coordinated client update is needed.
Legacy clients that insert Boat sandbox rows directly are deliberately no longer
supported: use the Armada launch API instead. There is no direct-registration
compatibility exception.

The migration changes grants and insertion policies only. It preserves recorded
sandboxes, provider identities, visibility, and existing read/update rules. It does
not inspect, delete, or reassign historical resources.
