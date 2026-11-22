# Settle historical Modal template receipts

After confirming the synchronous producers have drained, review the six historical
reservations from #2760 individually. Pass only the reviewed reservations on
stdin. Use unfiltered read-only database access for the preview and the
coordinator's server database access for settlement.

```sh
bun scripts/ops/settle-modal-template-receipts.ts --dry-run < reviewed.json
bun scripts/ops/settle-modal-template-receipts.ts --apply < reviewed.json
```

Dry-run uses `ARMADA_DRAIN_READ_ONLY_DATABASE_URL`. Apply uses
`ARMADA_DATABASE_URL`. Both print a decision indexed by the input row's
one-based position. A busy or deferred row exits nonzero and needs review.
Each successful row commits independently. Replaying the input recognizes
receipts already in a terminal state.

The following read-only query lists candidates and observed database versions.
Keep its results in the coordinator's private review. The script independently
checks the identities and evidence on apply.

```sql
select r.id as "requestId", r.sandbox_id as "sandboxId",
  r.org_id as "orgId", r.actor_id as "actorId",
  r.xmin::text as "receiptVersion", s.xmin::text as "sandboxVersion",
  r.manifest #> '{golden,modal}' as binding,
  r.manifest #>> '{golden,visibility}' as visibility,
  m.xmin::text as "journalVersion", m.record->>'phase' as "journalPhase"
from public.template_launch_requests r
left join public.sandboxes s on s.id = r.sandbox_id
left join public.modal_machines m on m.org_id = r.org_id
  and (m.id = s.provider_sandbox_id or m.request_key = r.sandbox_id::text
    or m.record #>> '{info,labels,sandbox}' = r.sandbox_id::text)
where r.state = 'reconciling'
  and r.manifest #>> '{golden,provider}' = 'modal'
  and r.created_at < timestamptz '2026-11-22 13:39:16+00'
order by r.created_at, r.id;
```

Supply a JSON array containing the first eight columns by name through
`visibility`, with each row's `evidence` object added. Use only the
`workspace`, `environment` and `appId` keys from `binding`. An absent
sandbox has a null `sandboxVersion`. Choose one evidence class per row.

- `{"kind":"delete-tombstone","journalVersion":"123"}` uses the matching
  Modal journal's full deletion proof for the recorded generation. Historical
  forks correlated by sandbox, org and owner labels even when their provider
  request key was random.
- `{"kind":"confirmed-absence","reference":"private review reference"}` is
  the coordinator's attestation that an authoritative inventory scoped to the
  frozen Modal binding and exact sandbox identity established final absence.
  An Armada sandbox must be absent or deleted. Add `journalVersion` to the
  evidence if a correlated journal exists. It must be unique, idle and match
  the reviewed version. Omit it only if no correlated journal exists. Leave
  the row out if provider-side evidence cannot be established.
  Zero native sandboxes, a missing App and an unscoped inventory miss are
  insufficient. The reference provides an audit pointer for the coordinator.
- `original-receipt` requires `reference`, `journalVersion`, and `receipt`.
  Supply the original successful public template receipt from durable evidence,
  with its frozen manifest and actual provider sandbox ID. The script verifies
  it against the sandbox, template reservation and idle provider journal.
  Use the public receipt artifact only.

After apply, rerun the six-count verification from #2760. The producer cutover
requires zero pending Modal template reservations and snapshot intents and
matching ordinary receipt counts.

Historical golden operation fences protect snapshots. They can outlive the
drained producer and remain in place through settlement. A retained fence
does not supply allocation or termination evidence. Active sandbox, job and
provider claims still defer settlement.
