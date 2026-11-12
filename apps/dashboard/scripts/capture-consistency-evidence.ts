/** Authorized dashboard families only: no Sandboxes list, skill picker or removed feature. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import { IDS, MOCK, reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/consistency-evidence";
await mkdir(output, { recursive: true });
const ACME = "00000000-0000-4000-8000-000000000010";
const routes = [
  ["environments", "/environments", "Environments"],
  ["templates", "/templates", "Templates"],
  ["tools", "/tools", "Tools"],
  ["variables", "/variables", "Variables"],
  ["skills", "/skills", "Skills"],
  ["harness", "/harness", "Models"],
  ["organizations", "/orgs", "Organizations"],
  ["members", `/orgs/${ACME}`, "Acme"],
  ["settings", "/settings", "Settings"],
  ["conversation", `/sandboxes/${IDS.running}`, "bx_alice_running"],
] as const;
const noOrg = routes.filter(([name]) => !["members", "conversation"].includes(name));
const names = [
  ...routes.map(([name]) => name),
  "cost-expanded",
  "restricted",
  "sign-in",
  "landing",
  ...noOrg.map(([name]) => `${name}-no-membership`),
  "settings-unavailable",
  "environments-unavailable",
];
if (names.length !== 24) throw new Error("Unexpected evidence matrix");
const post = async (path: string, body: unknown) => {
  const response = await fetch(`${MOCK}/__test/${path}`, { method: "POST", body: JSON.stringify(body) });
  expect(response.ok).toBe(true);
};
const browser = await chromium.launch();
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"] as const) {
      await reset();
      await post("sandbox-lifecycle", {
        id: IDS.running,
        fields: { status: "ready", conversation_ids: ["audit-conversation"] },
      });
      await post("sandbox-events", {
        sandbox: IDS.running,
        events: [
          {
            id: "audit-prompt",
            kind: "prompt",
            at: 1_762_596_300_000,
            text: "Review existing dashboard UI",
            status: "finished",
            conversationId: "audit-conversation",
            promptId: "audit-prompt",
          },
          {
            id: "audit-answer",
            kind: "message",
            at: 1_762_596_301_000,
            text: "Review complete. Existing actions remain available.",
            partial: false,
            tools: [],
            conversationId: "audit-conversation",
            promptId: "audit-prompt",
          },
        ],
      });
      const createContext = async () => {
        const context = await browser.newContext({
          baseURL: "http://127.0.0.1:3100",
          viewport: { width, height: 844 },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await context.addInitScript((v) => localStorage.setItem("theme", v), theme);
        return context;
      };
      const capture = async (page: Page, name: string) => {
        await page.evaluate(() => document.fonts.ready);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: join(output, `${phase}-${name}-${width}-${theme}.png`),
          fullPage: false,
          animations: "disabled",
        });
      };
      const alice = await createContext();
      try {
        const page = await alice.newPage();
        await signIn(page, "alice@example.com", "/environments");
        for (const [name, path, title] of routes) {
          await page.goto(path);
          await expect(
            page.getByRole("heading", {
              level: 1,
              name: name === "harness" && phase === "before" ? /^(?:Harness|Models)$/ : title,
              exact: true,
            }),
          ).toBeVisible();
          if (["environments", "templates", "tools", "variables"].includes(name))
            await expect(
              page.getByRole("list", { name: name === "variables" ? "Variables and secrets" : title, exact: true }),
            ).toBeVisible();
          if (name === "skills")
            await expect(page.getByRole("list", { name: "Skillpack keys", exact: true })).toBeVisible();
          if (name === "harness")
            await expect(page.locator("[data-account]").filter({ visible: true }).first()).toBeVisible();
          if (name === "organizations")
            await expect(page.getByRole("list", { name: "Your orgs", exact: true })).toBeVisible();
          if (name === "members") await expect(page.locator('[data-member="alice@example.com"]')).toBeVisible();
          if (name === "settings") await expect(page.locator('[data-settings="providers"]')).toBeVisible();
          if (name === "conversation")
            await expect(
              page
                .getByRole("log", { name: "Messages" })
                .getByText("Review complete. Existing actions remain available.", { exact: true }),
            ).toBeVisible();
          await capture(page, name);
          if (name === "conversation") {
            if (width < 1024) await page.getByRole("button", { name: "Details", exact: true }).click();
            await page.getByText("Per turn", { exact: true }).click();
            const table = page.getByRole("table", { name: "Cost per turn", exact: true });
            await expect(table).toBeVisible();
            await table.scrollIntoViewIfNeeded();
            await capture(page, "cost-expanded");
          }
        }
        await post("provider-status-fail", { fail: { status: 503, code: "unavailable", message: "Try again soon." } });
        for (const [name, path, title] of routes.filter(([name]) => ["settings", "environments"].includes(name))) {
          await page.goto(path);
          await expect(
            page.getByRole("heading", {
              level: 1,
              name: name === "harness" && phase === "before" ? /^(?:Harness|Models)$/ : title,
              exact: true,
            }),
          ).toBeVisible();
          await expect(page.locator('[data-setup-state="unavailable"]').first()).toBeVisible();
          await capture(page, `${name}-unavailable`);
        }
      } finally {
        await alice.close();
      }
      await reset();
      const carol = await createContext();
      try {
        const page = await carol.newPage();
        await signIn(page, "carol@example.com", "/orgs");
        for (const [name, path, title] of noOrg) {
          await page.goto(path);
          await expect(
            page.getByRole("heading", {
              level: 1,
              name: name === "harness" && phase === "before" ? /^(?:Harness|Models)$/ : title,
              exact: true,
            }),
          ).toBeVisible();
          await capture(page, `${name}-no-membership`);
        }
      } finally {
        await carol.close();
      }
      const bob = await createContext();
      try {
        const page = await bob.newPage();
        await signIn(page, "bob@example.com", `/sandboxes/${IDS.running}`);
        await expect(page.getByText("Owner and admins only", { exact: true })).toBeVisible();
        await expect(page.getByRole("log", { name: "Messages" })).toHaveCount(0);
        await capture(page, "restricted");
      } finally {
        await bob.close();
      }
      const publicContext = await createContext();
      try {
        const page = await publicContext.newPage();
        await page.goto("/login");
        await expect(page.getByText("Sign in to Armada", { exact: true })).toBeVisible();
        await capture(page, "sign-in");
        await page.goto("/landing");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await capture(page, "landing");
      } finally {
        await publicContext.close();
      }
    }
} finally {
  await browser.close();
}
if (phase === "after") {
  const parts: string[] = [];
  for (const name of names)
    for (const width of [1280, 390])
      for (const theme of ["light", "dark"]) {
        parts.push(`<h2>${name} ${width}px ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const file = `${side}-${name}-${width}-${theme}.png`;
          parts.push(`<a href="${file}">${side}<img src="${file}" alt="${side} ${name} ${width} ${theme}"></a>`);
        }
        parts.push("</div>");
      }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Dashboard consistency evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Consistency before/after</h1><p>192 mock-only captures:24 states × desktop/phone × themes × phases. Sandboxes list, skill pickers and removed features excluded. No-membership fixtures show each page's real empty/personal state; unavailable provider is an error, not an empty list. Loading is source-audited, not faked in screenshots. Marketing intentionally dark under either theme. Source provenance in README.txt.</p>${parts.join("")}`,
  );
}
