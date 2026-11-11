# Default skills from the CLI (#1007)

Select the Armada organization once, then manage non-secret exact pins:
```sh
armada org use Acme
armada skills defaults get --json
armada skills defaults set --skill review-code@2.0.0
armada skills defaults set --scope org --skill example/browser-testing@1.4.0
armada skills defaults set --scope golden --golden-id GOLDEN_UUID --skill notes@1.0.0
armada skills defaults set --clear
armada launch shared --agent codex --no-default-skills --skill notes@1.0.0
```

Set replaces the entire selected scope. Empty input never implicitly clears:
use --clear deliberately. Personal is the default scope and follows the user
across organizations; --org NAME|UUID overrides the saved selection.
Organization and shared-environment writes require admin; private environments
require their owner. The server authorizes every operation.

Merge priority is environment → organization → personal → template → explicit.
Later pins replace the same slug, with at most 20 exact distinct slugs.
--no-default-skills on ordinary launches excludes the first three layers, not
explicit --skill selections. Omitting it preserves the existing launch body.
Template launch overrides are outside this small CLI slice.

The terminal contacts only Armada's API. It neither contacts Skillpack nor
holds a Skillpack/provider key. Exact pins are metadata, not credentials;
--json returns only the skills list. No migrations or new configuration.
