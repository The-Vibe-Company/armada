# Modal launch timing (#2767)

The server emits one `modal_launch_timing` JSON record after the shared golden
launcher publishes a successful launch. The measured intervals end at harness readiness. Use the logical `sandboxId` to join the
record with the existing launch stages and runtime events. The `path` field
distinguishes the enrolled and native runtime paths.

Each `stages[].ms` is a consecutive interval on the server's monotonic clock.
`totalMs` starts when the shared golden launcher accepts the request and ends
after it records harness readiness. This boundary excludes request routing
before the shared launcher, initial prompt dispatch, and final state publication
and cleanup. For idle launches, the first event can occur long after readiness.

| Interval ends at | Work included |
| --- | --- |
| `launch_plan` | Golden lookup, placement and launch defaults, skill and connection validation |
| `credential_resolution` | Main credential resolver |
| `preallocation_admission` | Credential validation, repository authorization, golden fence, account admission and pre-fork checks |
| `provider_allocation` | Provider fork, including native runner installation, startup, and health on the native Modal path |
| `registration_and_binding` | Sandbox row and stage writes, lease handoff and connection binding |
| `machine_readiness` | Provider readiness wait and its stage write |
| `runtime_startup` (enrolled) | Runtime configuration, bootstrap, enrolment and runtime health |
| `workspace_preparation` | Workspace setup and checkout stage write, plus preceding native setup on the native path |
| `finish_initialization` | Remaining skills, connections, and pre-start work |
| `ready_stage_record` | Harness-ready stage write |

## Staging baseline

Modal launch p50 and p95 are pending coordinator measurement. The individual
12.3 s staging and 17.3 s production measurements cited in #2767 do not establish
percentiles. The program targets 8 s p50 and 12 s p95.

For successful staging launches, record the deployed SHA, date, path, sample
count, and workload. Calculate nearest-rank p50 and p95 from `totalMs` and
compare the summed intervals with an independently measured wall time using the
same admission and readiness boundary. Report request-to-ready wall time
separately to show work outside that boundary. Per-launch SQL counts and separate
download/verification, enrolment wait, and first-event measurements are pending.
