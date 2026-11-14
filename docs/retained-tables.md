# Retired observation schema
Owner decision #1905 removes all Otto application code, not the existing production observation data.
These pre-November-14 tables remain unchanged, with their policies, grants, functions and triggers:
- otto_facts
- otto_github_pages
- otto_tasks
- otto_resources
- otto_orphan_days

Their generated application types are omitted. Retirement requires a separate owner decision.
The type generator reads the list above as the retired-table inventory.

The removal migration drops only November-14 tables (including their indexes, constraints,
policies and grants) and the question-cap trigger function. Deploy via the authorized
release path only. Stop old servers/workers before schema removal: older feature routes
are incompatible with the destructive migration. No remote operation is authorized here.
