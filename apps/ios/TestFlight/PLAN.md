# TestFlight operation plan — root only

Nothing in this directory uploads, registers apps, sends invitations or claims a
successful build. Signing/authentication remains in the Mac Keychain. No App Store
app/build/group IDs are assigned yet.

## Discovery / dry run (root on Mac)

First inspect the installed CLI rather than guessing version-specific flags:

```sh
asc --version
asc apps --help
asc apps list --output table
asc builds --help
asc testflight --help
asc publish testflight --help
```

Read-only listing is discovery, **not** a mutation dry-run. Do not assume that
upload/create/distribute commands support `--dry-run`. If the installed CLI
supports workflows, inspect `asc workflow --help` and use its documented
`asc workflow run --dry-run` against a locally reviewed workflow before executing
it. No workflow containing unknown IDs is checked in here.

Root registers a **separate Armada** app record for `co.thevibecompany.armada`
after verifying name/bundle/team availability. Verify the returned record before
assigning its actual ID locally:

```sh
: "${ARMADA_ASC_APP_ID:?root supplies verified new Armada app ID}"
asc builds list --app "$ARMADA_ASC_APP_ID" --output table
asc testflight groups list --app "$ARMADA_ASC_APP_ID" --output table
```

Do not run registration or reuse an unrelated app record from this worker.

## Metadata prepared for root approval

- Beta app name: Armada
- Language: en-US
- Beta description: Native access to Armada organizations and orchestrator chat.
  Availability depends on your organization's enabled backend capabilities.
- What to Test: `what-to-test.txt`, trim against the actual verified feature set.
- Feedback email, privacy policy, support/marketing URLs, review contact, demo
  account/access notes and export-compliance answers: root must supply/approve;
  never invent contact details or commit account credentials.
- App icon and screenshots: original Armada assets from #691, validated on the
  exact integrated source. No Companion branding or old store IDs.

## Explicit mutation sequence (not worker authorization)

1. Root completes README prerequisites and records source/toolchain receipts.
2. Root creates/verifies the new app record and signs/archives/exports on Mac.
3. Root inspects installed `asc publish testflight --help`, then supplies the
   verified Armada app ID, exported IPA path and intended group IDs to its
   documented upload command. Do not run it with placeholders.
4. Record the actual upload receipt and build ID, wait for processing, verify
   bundle/version/build and resolve compliance before continuing.
5. Root applies approved beta metadata/What to Test using the installed CLI's
   help-discovered commands. Review diff/read-back before distribution.
6. Root explicitly authorizes internal/external group distribution. External
   beta review, if necessary, is a separate approval; do not auto-submit,
   create public links, invite testers or send messages.
7. Read back processing/distribution status and report real app/build IDs and
   receipts privately to the integrator. Never label an archive or dry-run an
   upload success.

CLI syntax reference: https://github.com/rorkai/App-Store-Connect-CLI
Project generation reference: https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md
