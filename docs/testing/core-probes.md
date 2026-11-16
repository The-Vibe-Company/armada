# Core native conformance probes

Ordinary `bun test` discovery excludes `.probe.ts`. Run a probe with its explicit
`./packages/core/test/<name>.probe.ts` path. A skipped probe is not acceptance.

The existing publishing release validation runs these probes in one explicit
native-contract process, after the ordinary single-process unit run:

- `database-types.probe.ts`: fresh-schema generation equals committed wire types;
- `private-skill.probe.ts`: real guest installer/auth-file/receipt protocol;
- `golden-scan.probe.ts`: actual scanner, filesystem and Git-history behavior;
- `work-preservation.probe.ts`: Git/archive/encryption recovery and refusal paths.

The existing release contract guard requires a successful, non-skipped sentinel
from every selected probe. Any failing case also fails that publishing step.
There is no new PR job/check, timeout, retry, deployment or provider call.
Generated-type parity no longer runs on every PR: authors must run its explicit
probe locally, and publishing blocks mismatched generated output. These procedures
do not establish that a publishing release or deployed smoke passed.

`golden-os.probe.ts` is a separate opt-in OS/SSH diagnostic. It needs the existing
`ARMADA_GOLDEN_OS_IMAGE` fixture image and Docker, and performs real package/browser
installs in a disposable container. It is not automatically run by these release
commands; no exact deployed equivalent for its user/root-NNP matrix is claimed.
Do not run it without the owner's resource/network authorization.

Cheap fake-provider, closed-error and generated-recipe contracts remain ordinary
unit tests. Their proofs do not claim actual provider or OS lifecycle acceptance.
