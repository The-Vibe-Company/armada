# Accessibility basics: focused changes and manual checks

Refs #971. This is not a full accessibility certification or an App Store
accessibility-label declaration.

## What changed

| Before | After | Why |
| --- | --- | --- |
| Assistant links had 3.50:1 contrast on the pale bubble and 4.02:1 on white | 4.85:1 and 5.57:1 respectively; dark-mode 4.66:1 unchanged | Small text should meet the 4.5:1 baseline |
| Sandbox title/metadata stayed single-line at accessibility sizes | Title/time stack and important metadata wrap at AX sizes | Preserve readable names and configuration |
| VoiceOver row summary omitted visible agent/model | Both are included; restriction text remains | Match information available visually |
| Composer could occupy six enlarged text lines | Three scrolling lines at AX sizes, six at normal sizes | Keep keyboard and Send reachable; no draft truncation |
| Link preview title/domain had fixed line caps at AX sizes | Full wrapping at AX sizes | Avoid hiding the descriptive link text |
| Working indicator forced a single line | Label wraps in a growing rounded chip | Keep the working state readable |

Ratios are analytical sRGB measurements of the actual code palette, not sampled
device screenshots. The lighter blue changed from 007AFF to 0066CC; 0A84FF dark
mode and unrelated icon/status colors are untouched. The target is scoped to
assistant links on their actual bubble/inner-card backgrounds.

The earlier audit described the link preview's 12/16-point fonts as text. Source
inspection shows those are decorative icons; readable title/domain text already
uses semantic styles. Icon geometry is deliberately unchanged here.

## Exact macOS / TestFlight checks

1. Run apps/ios/scripts/verify.sh. This is presentation-only: no new Core logic or
   source-string/font-inventory tests. Existing ArmadaKit tests and both app
   builds must pass.
2. On an iPhone-sized simulator/device, enable Settings → Accessibility →
   Display & Text Size → Larger Text → Larger Accessibility Sizes; move to the
   largest size. Check both compact portrait and landscape, then ordinary sizes.
3. Open the sandbox list with long names and a model configured. At AX sizes,
   names and status/owner/agent/model wrap; timestamp/status move below the title.
   At normal sizes the compact row remains. Verify the row still navigates and
   collapsed groups still work.
4. Enable VoiceOver. Each sandbox row is one stop and announces its full name,
   status, provider, agent, owner, model when present, creation age and existing
   owner/admin restriction when applicable. Decorative icons must not become
   extra stops. Metadata-only rows must not gain conversation access.
5. In an idle owned sandbox, paste an eight-line draft with the keyboard open at
   the largest type size. Send stays visible with its existing 44pt target; the
   field scrolls after three visible lines. Move the caret through the draft,
   Select All/Copy and confirm all eight lines remain; no send is needed.
6. Inspect an existing assistant message with an inline link and a standalone
   link with a long descriptive title/domain. At AX sizes the preview text wraps
   fully; it remains a native link with its existing Open/Copy actions and label.
   In light/dark appearance check enabled link readability against the bubble.
7. On a working conversation, the working label is fully readable without a
   one-line crop. VoiceOver announces it once, not its decorative spinner.
   Check existing Send, copy-code, jump-to-latest and account controls retain
   their 44pt targets; turn on Reduce Motion and ensure no new animation occurs.
8. Repeat these checks on TestFlight after merge. A fresh TestFlight build is
   needed for this batch. Linux cannot run the iOS simulator; no VoiceOver,
   keyboard, screenshot or physical-device result is claimed here.

References:
[Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility),
[Apple Larger Text criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/larger-text-evaluation-criteria),
[W3C contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum).
