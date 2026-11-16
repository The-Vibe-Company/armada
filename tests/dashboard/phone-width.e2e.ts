import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// #2522: on a phone the Large fixture's longest names must stay inside their card (not clip at the viewport and
// widen the page). One test per theme at 390×844 over every catalog page and the sandbox list.
const PAGES = [
  { path: "/templates", heading: "Templates" },
  { path: "/snapshots", heading: "Snapshots" },
  { path: "/tools", heading: "Tools" },
  { path: "/variables", heading: "Variables" },
  { path: "/sandboxes", heading: "Sandboxes" },
];

for (const theme of ["light", "dark"] as const) {
  test(`Large: long names stay inside their cards on a phone (${theme})`, { session: "large" }, async ({
    app,
    screen,
    browser,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await browser.emulateMedia({ colorScheme: theme });
    for (const page of PAGES) {
      await app.open(page.path);
      await expect(screen.getByRole("heading", { name: page.heading, level: 1 })).toBeVisible();
      expect(await browser.locator("html").getAttribute("class")).toContain(theme);
      // The document keeps the phone's width: nothing overflows it into horizontal panning.
      expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      // Each chip is bounded by the card or row that holds it; it truncates inside that boundary, not past it.
      const escaped = await browser.evaluate(() => {
        const out: string[] = [];
        for (const chip of document.querySelectorAll("main span[data-slot=badge]")) {
          const card = chip.closest("li, tr") ?? document.querySelector("main");
          if (!card) continue;
          const bounds = card.getBoundingClientRect();
          const box = chip.getBoundingClientRect();
          if (box.right > bounds.right + 0.5 || box.right > innerWidth + 0.5)
            out.push(`${chip.textContent?.slice(0, 32)} @${Math.round(box.right)} in ${Math.round(bounds.right)}`);
        }
        return out;
      });
      expect(escaped).toEqual([]);
    }
  });
}
