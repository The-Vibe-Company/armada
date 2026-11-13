# Modal checkpoint quiescence and legacy recovery (#732)

## Repair

Legacy recovery was fixed in #755 and is confirmed stopped in production. This
follow-up changes no recovery or database behavior.

Bootstrap introduces root control/launcher processes after the original baseline
capture. The adapter now seals exact root PID/start identities once after trusted
bootstrap health, before active publication or user admission. The authenticated
health responder PID is excluded even if UID/inspection is ambiguous: the private
Runner owns the journal and must terminate. Positive managed-state FD/cwd evidence
also vetoes a control exemption.

There is no general descendant, session or root-UID exemption. Real root orphans
adopted by `PR_SET_CHILD_SUBREAPER` cannot gain trust through a new parent. Once
admitted, a baseline can never be recaptured; legacy health without a PID grants
no extra control trust. Unknown post-admission root processes still refuse.

Survivor logs include closed `processUidClass`, `processIsAncestor`, `processIsPid1`,
`processCommClass`, `processExeClass`, `processRole`, `processStateClass`,
`processManagedState` and `processSurvivorCount` alongside existing category,
failure and inspection-primitive/errno fields. The traits describe the first
survivor; count covers all remaining writers (capped at 4096). No raw process name,
command line, executable path, PID or environment is logged. An opaque orphan may
still refuse; these fields distinguish it from recognized platform control work.

## Ordinary Modal stop (additional production evidence)

The 07:40–07:43Z report on #732 shows the same privileged-writer scrub refusal
on an ordinary sandbox, after runner checkpoint failures classified as gRPC and
Armada refusal. Ordinary stops use the same bootstrap seal,
runner checkpoint, process scrub and filesystem snapshot sequence. This repair
therefore applies to fresh ordinary forks as well as managed parents. Successful
ordinary stop must retain a new recovery image without
`checkpoint_failed_disk_not_retained`; its existing bounded fallback is not a
successful disk-retention validation and remains unchanged.

The preceding gRPC classification alone does not identify a transport cause or
prove that the runner checkpoint committed. Do not bypass its durable watermark
ACK requirement, retry an uncertain RPC blindly, or interpret a later scrub log
as proof that the earlier runner attempt succeeded. If a fresh post-deployment
ordinary stop still fails at the runner stage, capture the closed stage/reason
and investigate that separately; do not count fallback termination as this
ticket's successful smoke.

For an ordinary sandbox, verify first stop reports stopped with no disk-loss
note, then trigger the supported resume through exec and verify a filesystem
marker survives, then stop again with no disk-loss note. These live provider
checks have not been performed in
this development session.

## Deployment prerequisites

Deploy the updated server and rebuilt runtime artifact through the normal
coordinator-owned procedure. Fresh launches receive the public runtime overlay;
no migration, golden rebuild, credential change or production SQL edit is needed.
Existing admitted parents never acquire a reconstructed control set. Old checkpoint
images whose health lacks a PID retain conservative legacy scope. No deployment was performed
while developing this repair.
