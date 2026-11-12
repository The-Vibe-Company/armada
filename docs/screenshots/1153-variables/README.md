# Variables detail panel — issue #1153, Variables slice

Every viewport comparison is **before left / after right**, using the existing mock APP_REGION entry; no real accounts or secret values were captured.

| Viewport | Light | Dark |
| --- | --- | --- |
| Desktop 1280 × 844 | [Compare](variables-1280-light.jpg) | [Compare](variables-1280-dark.jpg) |
| Phone 390 × 844 | [Compare](variables-390-light.jpg) | [Compare](variables-390-dark.jpg) |

Before uses the shared component in the inherited inline mode (`detailPanel` opt-in disabled). After opts Variables into the right-hand modal. Viewport captures finish animation without timing sleeps and do not include offscreen page content around fixed sheets. The chosen row is scrolled into view before geometry is measured.

`e2e/variables-panel.e2e.ts` captures every view, verifies unchanged list geometry, selected-row highlight, panel focus and full width on phones, presses Escape and checks hidden panel, restored row focus and closed URL. Its history sequence covers Back, close, outside, direct-link reload, J/K and nested Delete (Escape and Back). A distinct secret replacement regression types a disposable unsubmitted fixture, presses Back, checks both dialogs close, and reopens to verify the password field is empty. No secret is revealed or submitted by this regression.

Negative controls: desktop modal assertions fail against inherited inline mode; before the VaultPanel lifetime fix, Back incorrectly leaves the secret replacement dialog visible above the closed detail.
