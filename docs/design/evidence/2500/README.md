# Issue #2500 visual evidence

Captured at 1440×900 and 390×844, light and dark. Prototype first; fixtures use Acme and Large. Dialog animations were finished before capture.

API gaps: Skills exposes private-skill keys, not a synchronized skill catalog, versions, installation toggles or run counts. Vault lists metadata, so stored values are not shown in the table; authorized reveal remains in details. Tool attachment counts are unavailable. OpenCode remains a supported extra model filter. Existing service connection actions remain below Tools.

Validation on source commit `e44bfe457fcc2ba3eca81c3892dfa338e0b8b71d`:

- `bun run lint` and `bun run typecheck`: passed.
- Targeted unit tests (`models-page`, `variables`, `resource-list`, `skillpack-key`): 48 passed.
- `bun run e2e tests/dashboard/models.e2e.ts tests/dashboard/resources.e2e.ts tests/dashboard/sandboxes.e2e.ts --grep 'inspect|filter|long account|fixture sign-in'`: 20 passed across desktop/phone, including fixture setup.
- Full `bun run e2e`: 38 passed, 14 failed. Twelve failures match two existing “Launch a sandbox” buttons on unchanged Sandboxes; two desktop failures match duplicate sidebar/main sandbox links. This is an outstanding full-suite blocker, not a green journey run.
- Independent Alibaba/OCR review: no outstanding findings. Every source file reviewed.

Local QA used Node 24 with Chromium libraries and fonts. No migrations or deployment prerequisites.
