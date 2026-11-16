# Normal Docker launch startup diagnostics (#2308)

Source builds have a null official image pin. They select the immutable
`SOURCE_SANDBOX_IMAGE` digest in core (published 2.29.0 toolchain baseline,
30455768ce82…), not the last release, latest tag, or daemon version.
Release builds replace that null with a version-matched published digest.
Snapshots retain their own host-local image.

Image age is not runtime age: the daemon downloads the server descriptor's
runtime artifact, verifies bytes and SHA256, installs it in the owned volume,
and executes that binary. Enrolment then supplies the server's harness manifest.
Consequently the three-day-old base does not, by itself, explain a protocol
mismatch 200 ms after enrolment. Upgrading a daemon does not update image
selection. Production release pin generation waits for image publication;
a malformed/mismatched pin refuses launch before creation.

The launch logger previously left `reason=runtime_configuration` across the
whole bootstrap/readiness path. It was not evidence of a configuration
projection failure. That projection happens *before* enrolment. Post-enrolment
startup includes harness artifact installation, endpoint/auth projection,
filesystem setup and native runtime startup. Exceptions were discarded by
main's catch; progress sent only `runtime_failed`. This is the demonstrated
observability defect, not proof of which environment dependency failed.

Startup progress now carries a closed phase sub-reason, persisted as actionable
status text and logged with sandbox/epoch. Unknown text is rejected rather than
logged (credentials can appear in errors). Older runtimes remain accepted with
generic operator guidance. Launch logs distinguish bootstrap from readiness.
Environmental failures no longer recommend an identical immediate relaunch.

## Coordinator verification (not performed here)

On staging, use the **normal dashboard Docker launch**, not explicit-image
preview smoke, on stan-oneclick with Codex/OpenAI API key. Check startup success
or the authenticated runtime stage's sub-reason and corresponding status text.
If artifact preparation fails, inspect server artifact availability and owned
container filesystem permissions; if auth/routing fails, inspect that configured
account/endpoint. Capture the specific failing dependency before any further
environmental fix. Confirm the banner asks for repair before retry.
No production mutation is needed to establish this diagnostic.
