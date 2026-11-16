# Models providers redesign (#2380)

Fixture-only captures at 1440px desktop and 390px phone widths. No real credentials or provider calls.

Reference studied: [T3 Code Providers settings](https://github.com/pingdotgg/t3code/tree/main/apps/web/src/components/settings), including `ProviderSettingsPanel.tsx` and `AddProviderInstanceDialog.tsx`. Layout and interaction reimplemented using Armada's existing account actions. The three bundled brand marks are adapted from T3 Code's `Icons.tsx`; its MIT license is retained in `third-party/t3code-LICENSE`.

Armada does not track installed provider binary versions or expose an account enable/disable mutation, so neither is invented. Refresh reloads account metadata; it does not claim a provider health check. Existing account usage, launch defaults, scope, limits, connection checks, replacement and deletion remain available.

The coordinator must compare the rendered page and dialog with the owner's screenshots on staging, in both themes and organizations. Verify keyboard-only subscription sign-in/paste, API-key creation, defaults, reconnect/replacement, limits, connection-test availability, deletion, and loading/empty/error states. Real authentication/provider verification is not proven by fixture screenshots.
