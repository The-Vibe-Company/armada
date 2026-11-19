import { expect, test } from "bun:test";
import { checkAgentsFiles } from "./agents-guard";

const missing = () => false;

test.each([
  ["AGENTS.md", 9_216],
  ["packages/mcp-server/AGENTS.md", 7_168],
  ["nested/AGENTS.md", 4_096],
] as const)("%s enforces its UTF-8 byte budget", (path, budget) => {
  const files = new Map([
    [path, "é".repeat(budget / 2)],
    [path.replace("AGENTS.md", "CLAUDE.md"), "@AGENTS.md\n"],
  ]);
  expect(checkAgentsFiles(files, missing)).toEqual([]);
  files.set(path, files.get(path) + "é");
  expect(checkAgentsFiles(files, missing)).toEqual([
    `${path}: byte budget: ${budget + 2} bytes exceeds ${budget} bytes`,
  ]);
});

test("reports issue references and dates as history", () => {
  const files = new Map([["AGENTS.md", "See #2610 from 2026-11-19."]]);
  expect(checkAgentsFiles(files, missing)).toEqual(["AGENTS.md: history: #2610", "AGENTS.md: history: 2026-11-19"]);
});

test("validates repository path tokens and skips inline code that is not a path", () => {
  const files = new Map([
    [
      "AGENTS.md",
      "`docs/known.md` `missing.ts` `docs/*.{md,txt}` `src/*.ts` `bun run lint` `sandboxes.status` `@armada/core/contract`",
    ],
  ]);
  const existing = new Set(["docs/known.md", "docs/*.{md,txt}"]);
  expect(checkAgentsFiles(files, (path) => existing.has(path))).toEqual([
    "AGENTS.md: missing repository path: missing.ts",
    "AGENTS.md: missing repository path: src/*.ts",
  ]);
});

test("requires a nested sibling that redirects to AGENTS.md", () => {
  const files = new Map([["nested/AGENTS.md", "Rules"]]);
  expect(checkAgentsFiles(files, missing)).toEqual([
    "nested/AGENTS.md: sibling redirect: nested/CLAUDE.md must contain @AGENTS.md (found missing)",
  ]);
  files.set("nested/CLAUDE.md", "@elsewhere.md\n");
  expect(checkAgentsFiles(files, missing)[0]).toContain("@elsewhere.md");
  files.set("nested/CLAUDE.md", "@AGENTS.md\n");
  expect(checkAgentsFiles(files, missing)).toEqual([]);
});

test("exempts only the dashboard's generated Next.js rules", () => {
  const generated = [
    "<!-- BEGIN:nextjs-agent-rules -->",
    "#2610 `node_modules/next/README.md`",
    "x".repeat(5_000),
    "<!-- END:nextjs-agent-rules -->",
  ].join("\n");
  const files = new Map([
    ["apps/dashboard/AGENTS.md", `${generated}\n#2853`],
    ["apps/dashboard/CLAUDE.md", "@AGENTS.md\n"],
    ["AGENTS.md", generated],
  ]);
  expect(checkAgentsFiles(files, missing)).toEqual([
    "apps/dashboard/AGENTS.md: history: #2853",
    "AGENTS.md: history: #2610",
    "AGENTS.md: missing repository path: node_modules/next/README.md",
  ]);
});
