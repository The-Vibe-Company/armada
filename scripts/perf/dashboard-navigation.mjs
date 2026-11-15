/** Fixture-only warm navigation benchmark. See dashboard-navigation.md for startup.
 * Run: node scripts/perf/dashboard-navigation.mjs [chromium-executable]
 * Use a fixture production build for prefetch measurements; dev mode disables prefetch.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../../apps/dashboard/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
});
try {
  const page = await browser.newPage();
  await fetch("http://127.0.0.1:54399/__test/reset", { method: "POST" });
  await page.goto("http://127.0.0.1:3100/login");
  await page.getByLabel("Email", { exact: true }).fill("alice@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/sandboxes");
  const detail = "/sandboxes/00000000-0000-4000-8000-000000000030";
  for (const [source, target] of [
    ["/snapshots", "/sandboxes"],
    ["/sandboxes", detail],
    ["/sandboxes", "/snapshots"],
  ]) {
    const samples = [];
    const requests = [];
    const record = (request) => {
      const headers = request.headers();
      if (headers.rsc || headers["next-action"])
        requests.push({
          url: request.url(),
          prefetch: headers["next-router-prefetch"] ?? null,
          action: Boolean(headers["next-action"]),
        });
    };
    page.on("request", record);
    const feedback = [];
    for (let i = 0; i < 6; i++) {
      // A fresh document resets the client router cache. Then use the real destination link.
      await page.goto("http://127.0.0.1:3100" + source);
      await page.locator("main h1").waitFor();
      const link = page.locator('a[href="' + target + '"]').first();
      await link.waitFor();
      const start = performance.now();
      await page.evaluate((target) => {
        window.__navStart = performance.now();
        window.__navFeedback = null;
        const observer = new MutationObserver(() => {
          const h = document.querySelector("main h1")?.textContent ?? "";
          const ready =
            target === "/sandboxes"
              ? h === "Sandboxes"
              : target === "/snapshots"
                ? h === "Snapshots"
                : h.includes(" / ");
          if (
            location.pathname === target &&
            (document.querySelector('main [aria-label="Loading page"], main [aria-label="Loading sandboxes"]') || ready)
          ) {
            window.__navFeedback = performance.now() - window.__navStart;
            observer.disconnect();
          }
        });
        observer.observe(document.querySelector("main"), { childList: true, subtree: true });
      }, target);
      await link.evaluate((element) => element.click());
      await page.waitForURL("**" + target);
      await page.waitForFunction((target) => {
        const h = document.querySelector("main h1")?.textContent ?? "";
        return target === "/sandboxes"
          ? h === "Sandboxes"
          : target === "/snapshots"
            ? h === "Snapshots"
            : h.includes(" / ");
      }, target);
      if (i) {
        samples.push(Math.round(performance.now() - start));
        const firstFeedback = await page.evaluate(() => window.__navFeedback);
        if (firstFeedback === null) throw new Error("No destination feedback observed");
        feedback.push(Math.round(firstFeedback));
      }
    }
    page.off("request", record);
    samples.sort((a, b) => a - b);
    feedback.sort((a, b) => a - b);
    console.log(
      JSON.stringify({ source, target, requests, samples, feedbackP50: feedback[2], p50: samples[2], max: samples[4] }),
    );
  }
} finally {
  await browser.close();
}
