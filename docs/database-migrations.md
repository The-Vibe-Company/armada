# Automatic production migrations

> **Release-sync opt-in:** When repository variable `RELEASE_SYNCED_DEPLOYS=true`,
> the push-to-main production job and manual standalone migration apply are disabled.
> Tagged migrations run inside Release before server/dashboard/npm deployment, using
> the validated release SHA. Manual history, guarded repair and dry-run remain available;
> they still inspect current main and are not a tagged apply/recovery path.
> Use [release recovery and owner cutover](releasing.md#release-synchronized-production-owner-opt-in).
> The legacy behavior documented below applies only while the variable is absent/false.

The **Database migrations** workflow applies pending `supabase/migrations/*.sql`
after a push to `main` changes that directory. It uses Supabase CLI 2.75.0,
linked-project `db push`, and the remote migration history: re-running skips
already recorded versions. The automatic path never resets the database, repairs history, or
includes seeds. Manual repair is a separate guarded operation. The version tables before and after the push and the pending
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
automatic apply path intentionally does not run `migration repair` or `--include-all`.
No production operation is needed to review this PR.

## Staging environment

The independent **Staging migrations** job uses only this environment secret in
the **staging** GitHub Actions environment:

| Exact name | Value |
| --- | --- |
| `SUPABASE_DB_URL` | Staging session-mode pooler PostgreSQL connection URL including credentials and `sslmode=require` |

It connects directly with `supabase migration list --db-url` and
`supabase db push --db-url` (preview with `--dry-run`, apply with `--yes`).
No management API, `supabase link`, access token, project reference or separate
database password is needed. A missing URL emits a no-op notice before any
database connection. Never echo this secret or enable CLI debug/shell tracing.
Production configuration above is unchanged. See
[staging migration operation](post-deploy-smoke.md#staging-migrations).

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
  migrations → Run workflow**, branch **main**, selecting **mode=migrate**, leaving **dry_run=true**. It links,
  lists history and previews without applying application migrations. The CLI may
  initialize its migration-history metadata on first connection; this is not a
  read-only database credential and is never exposed to PR jobs.
- To retry applying pending migrations, dispatch on **main** with **mode=migrate**, **dry_run=false**,
  or rerun a failed push run. No migrations are applied on other refs.
- Production jobs share `production-supabase-migrations` with cancellation disabled.
  GitHub may replace queued runs; every job checks out current main, so the next
  job includes all committed pending migrations. Manual operations outside this
  workflow must not run concurrently.
- Editing only workflow/docs does not trigger a production push run. Dispatch a
  preview after setup; the next migration merge triggers application automatically.

See the [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-push)
for history tracking and dry-run behavior.

## Reconcile hand-applied history (operator only)

No production reconciliation was performed by this change. Do not copy the
CLI's suggested reverted versions blindly: removing a history row can make a
later push replay SQL that already exists.

For **history** and **repair**, additionally configure the production environment
secret **SUPABASE_DB_URL**: a PostgreSQL connection URI for the same project as
SUPABASE_PROJECT_ID, with a username, host, port and database, **without a password**.
Use the direct connection or session pooler endpoint supplied by Supabase;
SUPABASE_DB_PASSWORD supplies the password separately. TLS is required. These
modes do not link the project; verify the URI targets the intended project.
Never paste connection details into dispatch inputs or enable debug tracing.
The runner needs psql (preinstalled on ubuntu-latest).

1. Dispatch **Database migrations**, branch **main**, **mode=history**.
   This uses psql with a read-only transaction default and SELECT only, not the
   CLI's history initialization. It prints remote version/name, local
   version/filename, and remote-only, local-only and both sets. A missing history
   table fails rather than creating it. Names are informational, not proof of SQL
   equivalence; the sets compare versions only. No application data or migration
   statements are printed.
2. Build a per-file reconciliation record: local version, historical remote
   version/name if any, schema evidence, and proposed action. Compare names and
   read each local SQL file. An authorized operator must inspect production's
   actual tables, columns, constraints, indexes, functions, policies, grants and
   any data backfills affected by that file (using approved read-only tooling).
   Compare definitions, not just existence. Mark a local file applied only when
   **all** its effects are already present; names or matching timestamps alone
   do not establish this. For partial or uncertain effects, stop and investigate.
3. Dispatch **mode=repair**, with **versions** as one or more space-separated
   14-digit versions, **status=applied** and **confirmation** exactly
   `REPAIR PRODUCTION MIGRATION HISTORY`. This records verified local files as
   applied **without executing their SQL**. The dry_run switch does not guard
   repair: the typed confirmation is mandatory. Each run shows history before
   and after and runs only the CLI history-repair mutation, never db push.
4. Only after mapping old remote-only entries to verified local equivalents,
   consider a separate confirmed repair with **status=reverted** for those old
   versions. This removes history records; it does **not** undo schema changes.
   Never revert a local version whose SQL should not replay.
   The reported `20261110120300` model_auth_usage entry came from unmerged
   PR #677: inspect its actual effects and its eventual main migration before
   deciding anything. Do not remove it just to silence a mismatch, nor add or
   edit migration files to disguise drift.
5. Run **history** again, then **mode=migrate**, **dry_run=true**. Inspect every
   pending file: it must really be unapplied. Only then may the owner authorize
   normal application. Automatic push and migrate previews still fail on history
   mismatches; no automatic repair or include-all fallback is added.

All manual modes are main-only, use the production environment and share the
apply job's concurrency lock. Environment branch restrictions and optional
reviewer approval remain essential; do not run external repairs concurrently.
Keep the reconciliation record and Actions run links for audit. A failed repair
may have partially changed history: inspect fresh history before retrying.
