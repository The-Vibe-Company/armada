import { chromium } from "@playwright/test";

const [, , prefix, ...paths] = process.argv;
const base = "http://127.0.0.1:3100";
const browser = await chromium.launch();
for (const scheme of (process.env.SCHEMES ?? "light").split(",")) {
  for (const [w, h, tag] of [
    [1440, 900, "desktop"],
    [390, 844, "phone"],
  ]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      colorScheme: scheme,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/login?next=/goldens`);
    await page.getByLabel("Email").fill(process.env.EMAIL ?? "alice@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByLabel("Code").fill("123456");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120000 });
    for (const p of paths) {
      const [path, click] = p.split("#");
      await page.goto(base + path, { timeout: 120000 });
      await page.waitForLoadState("networkidle");
      if (click) {
        await page.locator(click).first().click();
        await page.waitForTimeout(500);
      }
      const name = `${prefix}-${path.replace(/\W/g, "") || "root"}${click ? "-sel" : ""}-${tag}-${scheme}.png`;
      await page.screenshot({ path: `/tmp/shots/${name}`, fullPage: !(click && tag === "phone") });
      console.log(name);
    }
    await ctx.close();
  }
}
await browser.close();
