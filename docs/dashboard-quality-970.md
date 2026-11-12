# Dashboard quality campaign (#970)

Feature freeze: improve existing controls, feedback and presentation, not the product's capabilities. Every slice references #970 without closing it. The coordinator owns merges. No migration or manual deployment is part of this campaign.

## Delivered slices and evidence

| Slice | Scope / demonstrated correction |
| --- | --- |
| #1004 | Six Build pages: standard controls, full-width resource detail, retained form state, warning/accessibility corrections; desktop/phone and light/dark evidence in that PR. |
| #1001 | Fleet retired with legacy redirects; essential existing attention actions retained in authorized sandbox detail/conversation. |
| #1025 | Conversation/detail controls and accepted-send/steer pending-draft loss; existing actions/privacy/viewport behavior retained. |
| #1044 | Personal-key removal and GitHub disconnect use deliberate destructive confirmations; cancel has no mutation, pending locks, refusal/retry and focus remain usable. |
| #1119 | Shared command palette uses Command primitives without changing app ranking/commands; actual keyboard Close and focus restoration. |
| #1122 | Organization create follows short-dialog pattern; sign-in code-step/refusal focus and accessible errors, without changing authentication or sensitive-code clearing. |
| Public landing slice | Clipboard denial is explicit, command remains selectable, real retry succeeds; same marketing typography/wrapping/animation and existing CTA destinations. |
| This consistency slice | Compact cost breakdown uses standard Collapsible/Table without changing prices, token reporting or row order. Outer phone Details state—not nested expansion—owns history layout. |

PRs may be independently ready before they merge. Their individual exact-head galleries remain the evidence for those pending changes. This slice's broad gallery is a comparison of its recorded main baseline and its exact head, **not** a claim that every unmerged branch has been combined into one deployed application.

## Consistency audit

| Family | Spacing / type / status | Empty, loading and error policy |
| --- | --- | --- |
| Environments, Templates, Tools, Variables | Shared PageHeader and resource rows; full-width selected detail; short create dialogs; semantic status badges rather than color alone. | Real data-empty/no-membership states remain distinct from read failure. Provider-unavailable stops provider mutations and offers an explicit retry. Existing Skeleton route fallbacks remain neutral. |
| Skills and Harness | Same header/action hierarchy, scope and account statuses. No Skill picker redesign. | Missing optional credentials are not fabricated failures. No-membership fixture shows each page's real personal/empty state. Existing loading Skeletons and field/action error handling retained. |
| Sandbox conversation/detail | Identifier wraps rather than clipping the machine action. Dense sidebar metadata intentionally uses smaller type than page headings. Composer stays reachable; history/details scroll within their own regions. | Quiet historical outcomes remain distinct from current failures. Restricted interiors never fetch/render conversation controls. Missing cost remains unreported, not zero. |
| Cost breakdown | Card/definition-list facts retained; compact six-column table and horizontal containment. Table primitives do not introduce new row shading or inflated spacing. | Partial/unknown tokens and price coverage retain their existing labels and amounts. This is a component change, not a pricing change. |
| Organizations and member detail | Existing role/active-org badges and roster hierarchy; create dialog change documented in #1122. | No-membership guidance and administrative boundaries retained. Member removal/self-demotion remain deliberate; ordinary edits do not gain confirmations. |
| Settings | Provider, personal-key and GitHub sections retain their hierarchy; #1044 documents missing destructive confirmations. | Provider unavailability is a retryable read error, never a pretend disconnected account. A delivery failure is not false field invalidity. Secret values are never redisplayed. |
| Sign-in | Centered short form; existing Input/Label/Alert patterns and unique associations in #1122. | Code errors describe/focus Code on each attempt. Sensitive one-time codes still clear. OAuth/return destination behavior unchanged. |
| Shared shell | Existing palette geometry and token system; #1119 keeps exact app matching/ranking with library keyboard semantics. | No-result recovery, escape/close, routing and focus are verified at the existing browser owner. |
| Public landing | Intentionally distinct, dark marketing design under either theme; no generic dashboard redesign. | Clipboard failure is honest and recoverable. Existing word wrapping, navigation anchors, sign-in/install destinations and reduced-motion behavior remain owned by landing tests. |

The existing `PageHeader`, status-badge, Alert and Skeleton foundations already establish the type/spacing/status vocabulary. A consistency pass is not a reason to change their global tokens, flatten useful hierarchy, or redesign another owner's page. Native definition lists, message logs and non-tabular resource lists remain semantic structures rather than becoming fake tables.

## Verification and screenshots

The consistency capture uses only the disposable Supabase/Armada mock. It includes **192 viewport PNGs**: 24 real page/state views × 1280px/390px × light/dark × before/after. Views cover the ten authorized authenticated surfaces, expanded cost, restricted metadata, public sign-in/landing, eight no-membership/personal-empty states, and Settings/Environments provider-unavailable errors. Each page waits for its real visible content; an unavailable provider is not mislabeled as an empty list. The offline gallery and README carry exact source provenance; artifact access follows repository permissions, with no preview token and no binary committed.

Loading components are source-audited at the actual route fallbacks and existing regression owners. The gallery does **not** fabricate loading frames or claim to screenshot every transient streaming state. Similarly, no-membership screenshots show what that user can really see; they do not hide personal resources to manufacture an empty page.

Cost and viewport owner tests retain all original price, refresh, keyboard, containment and history assertions. The new nested-disclosure check demonstrated an **induced migration regression** with the old broad selector, then passed after binding the layout to the outer section's state. It is not represented as a pre-existing main bug. The list's `RowCost` rendering remains byte-equivalent.

## Explicit exclusions and remaining decision

- Sandboxes list filters/design belong to #1005; its page and row-cost rendering are not changed here.
- Skill pickers belong to #1007; no picker source is changed or audited here.
- Orchestrator-specific pages/behavior are excluded by owner decision and remain untouched.
- Sonner preparation is inactive on a separate branch, pending owner choice: native queue, repeated-message timer and announcement/focus policies differ from the existing toast contracts. Do not silently weaken those contracts or build a second custom toast manager in the name of adopting a standard component.
- Shared Empty presentation is retained rather than changing the list owner's design through a global primitive. No speculative bug is claimed from an unused area or a sparse fixture.
