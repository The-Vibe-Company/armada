# Automatic production migrations

The **Database migrations** workflow applies pending `supabase/migrations/*.sql`
after a push to `main` changes that directory. It uses Supabase CLI 2.75.0,
linked-project `db push`, and the remote migration history: re-running skips
already recorded versions. It never resets the database, repairs history, or
includes seeds. The version tables before and after the push and the pending
plan are in Actions logs. Any failing command fails the job and emits an error.

## One-time repository administrator setup

Create the GitHub Actions environment named **production**. Restrict deployment
branches to **main** (not arbitrary tags/branches), restrict who can change its
configuration, and add these **environment secrets**, not repository secrets:

| Exact name | Value |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token from an account authorized for the production project |
| `SUPABASE_PROJECT_ID` | Production project reference from Supabase project settings (not a URL) |
| `SUPABASE_DB_PASSWORD` | Production project's database password, not its anon/service-role API key |

Use the least-privileged Supabase account available. Environment reviewers can
be enabled if policy requires approval, but each run then waits for that approval;
leave required reviewers off if fully unattended post-merge execution is desired.
Missing secrets fail closed. Do not paste credentials into dispatch inputs,
command arguments, logs or migration SQL; do not enable CLI debug/shell tracing.

Before enabling automation, an authorized database operator must check that
production's `supabase_migrations.schema_migrations` accurately records migrations
previously applied by hand. Otherwise the CLI may attempt to reapply them.
Reconcile discrepancies deliberately after verifying the actual schema; the
workflow intentionally does not run `migration repair` or `--include-all`.
No production operation is needed to review this PR.

## Railway ordering (required operational prerequisite)

Railway GitHub autodeploy and GitHub Actions are independent: **this workflow does
not gate or change Railway deployments**. A successful Railway build is not
evidence that migrations finished. Before merging schema-dependent server code,
the Railway administrator must hold/disable automatic promotion or configure an
external deployment gate that waits for **Production migrations** to succeed.
Release only after success, using server code compatible with the applied schema.
This ticket does not modify Railway configuration or deploy the server.

If Railway continues ungated autodeploy, code can go live before the schema; do
not merge schema-dependent releases under that configuration. Prefer additive,
backward-compatible migrations so the running old server survives schema rollout.
A failed migration blocks release, not necessarily an already independent Railway
deployment: the operator must keep that release held. Review Actions errors, assess
partial effects (do not assume a multi-statement file is atomic), and submit a new
forward migration or reviewed correction for an unapplied migration. Never edit
an applied migration or reset production.

## Preview, retries and PR checks

- On a PR, **Migration dry-run (disposable database)** runs without any production
  secrets or environment access, including on forks. It previews against empty,
  disposable PostgreSQL. Existing **Lint, typecheck and test** CI actually applies
  every SQL migration with Supabase prerequisite roles/schema to disposable
  PostgreSQL and runs the schema/RLS tests. This is not a remote drift check.
- For a remote-history comparison, an authorized maintainer can run **Database
  migrations → Run workflow**, branch **main**, leaving **dry_run=true**. It links,
  lists history and previews without applying application migrations. The CLI may
  initialize its migration-history metadata on first connection; this is not a
  read-only database credential and is never exposed to PR jobs.
- To retry applying pending migrations, dispatch on **main** with **dry_run=false**,
  or rerun a failed push run. No migrations are applied on other refs.
- Production jobs share `production-supabase-migrations` with cancellation disabled.
  GitHub may replace queued runs; every job checks out current main, so the next
  job includes all committed pending migrations. Manual operations outside this
  workflow must not run concurrently.
- Editing only workflow/docs does not trigger a production push run. Dispatch a
  preview after setup; the next migration merge triggers application automatically.

See the [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-push)
for history tracking and dry-run behavior.
