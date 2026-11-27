import { describe, expect, test } from "bun:test";
import type { GitHubReposResponse } from "@armada/core/contract";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { GitHubRepoPickerButton, GitHubRepoPickerContent } from "@/components/github-repo-picker";
import { RepositoryPicker } from "@/components/launch-repositories";
import {
  applyRepoSelectionToRows,
  buildGitHubRepoPickerView,
  buildGitHubReposRequest,
  classifyGitHubReposFailure,
  fetchGitHubReposWith,
  parseManualRepoInput,
  selectedRepoKeys,
} from "@/lib/github-repos";

const SAMPLE: GitHubReposResponse = JSON.parse(
  '{"truncated":false,"installations":[' +
    '{"id":101,"appId":9,"appSlug":"armada","accountLogin":"Vibe-Co","accountType":"Organization","repositorySelection":"all"},' +
    '{"id":102,"appId":9,"appSlug":"armada","accountLogin":"acme_emu","accountType":"Organization","repositorySelection":"all"},' +
    '{"id":103,"appId":9,"appSlug":"armada","accountLogin":"alice","accountType":"User","repositorySelection":"all"}],' +
    '"repositories":[' +
    '{"id":1,"owner":"Vibe-Co","name":"armada","fullName":"Vibe-Co/armada","private":true,"defaultBranch":"main","installationId":101,"accountLogin":"Vibe-Co","accountType":"Organization","repositorySelection":"all","archived":false,"pushedAt":null},' +
    '{"id":2,"owner":"Vibe-Co","name":"dashboard","fullName":"Vibe-Co/dashboard","private":false,"defaultBranch":"main","installationId":101,"accountLogin":"Vibe-Co","accountType":"Organization","repositorySelection":"all","archived":true,"pushedAt":null},' +
    '{"id":3,"owner":"acme_emu","name":"billing-api","fullName":"acme_emu/billing-api","private":true,"defaultBranch":"main","installationId":102,"accountLogin":"acme_emu","accountType":"Organization","repositorySelection":"all","archived":false,"pushedAt":null}]}',
);
const CHOICES: readonly (readonly [string, number])[] = [
  ["vibe-co/armada", 2],
  ["other-org/legacy", 1],
];

describe("github-repo-picker", () => {
  test("org pills, org/search filtering, multi-org grouping, and snapshot merge", () => {
    const all = buildGitHubRepoPickerView(SAMPLE, CHOICES, "all", "");
    expect(all.pills.map((p) => `${p.key}:${p.count}`)).toEqual(["all:3", "acme_emu:1", "alice:0", "Vibe-Co:2"]);
    const fmt = (g: (typeof all.groups)[number]) =>
      `${g.heading}=${g.items.map((x) => `${x.fullName}(${x.readyCount ?? 0})`).join(",")}`;
    expect(all.groups.map(fmt)).toEqual([
      "acme_emu · Org=acme_emu/billing-api(0)",
      "Vibe-Co · Org=Vibe-Co/armada(2),Vibe-Co/dashboard(0)",
      "Ready in snapshots=other-org/legacy(1)",
    ]);
    const emu = buildGitHubRepoPickerView(SAMPLE, CHOICES, "ACME_EMU", "billing", "acme_emu", "billing");
    expect(emu.groups.flatMap((g) => g.items.map((x) => x.fullName))).toEqual(["acme_emu/billing-api"]);
    expect(emu.pills.map((p) => p.count)).toEqual([undefined, undefined, undefined, undefined]);
    const trunc = buildGitHubRepoPickerView({ ...SAMPLE, truncated: true }, [["other-org/blocked", 0]], "all", "");
    expect(trunc.pills.every((p) => p.count === undefined)).toBe(true);
    expect(trunc.groups.at(-1)?.items[0]?.readyCount).toBeUndefined();
    expect(buildGitHubReposRequest("all", " ")).toEqual({});
    expect(buildGitHubReposRequest("acme_emu", " bill ")).toEqual({ account: "acme_emu", query: "bill" });
    const manual = buildGitHubRepoPickerView(SAMPLE, CHOICES, "all", "new-org/new-repo");
    expect([manual.showManual, manual.manualRepo]).toEqual([true, "new-org/new-repo"]);
    expect(buildGitHubRepoPickerView(SAMPLE, CHOICES, "all", "vibe-co/armada").showManual).toBe(false);
    const snap = buildGitHubRepoPickerView(null, CHOICES, "all", "armada").groups[0]?.items[0]?.fullName;
    expect(snap).toBe("vibe-co/armada");
  });

  test("manual owner/repo parsing and multi-org row toggling", () => {
    const ok = [
      ["  Vibe-Co/armada  ", "Vibe-Co/armada"],
      ["acme_emu/api.v2.git", "acme_emu/api.v2"],
      ["https://github.com/Vibe-Co/armada.git/", "Vibe-Co/armada"],
      ["git@github.com:acme_emu/web.git", "acme_emu/web"],
      ["ssh://git@github.com/alice/repo", "alice/repo"],
    ] as const;
    for (const [raw, want] of ok) expect(parseManualRepoInput(raw)).toBe(want);
    for (const bad of ["", "only-owner", "a/b/c", "../bad", "owner/..", "https://gitlab.com/a/b", "bad owner/repo"])
      expect(parseManualRepoInput(bad)).toBeNull();
    const mk = (url: string) => ({ url });
    const a = applyRepoSelectionToRows([mk("")], "Vibe-Co/armada", mk, 2);
    const b = applyRepoSelectionToRows(a, "acme_emu/billing-api", mk, 2);
    expect(b.map((x) => x.url)).toEqual(["Vibe-Co/armada", "acme_emu/billing-api"]);
    expect([...selectedRepoKeys(b.map((x) => x.url))]).toEqual(["vibe-co/armada", "acme_emu/billing-api"]);
    expect(applyRepoSelectionToRows(b, "alice/extra", mk, 2)).toHaveLength(2);
    const c = applyRepoSelectionToRows(b, "vibe-co/armada", mk, 2);
    expect(applyRepoSelectionToRows(c, "acme_emu/billing-api", mk, 2)).toEqual([mk("")]);
  });

  test("request/response validation, failure classification, and SSR states", async () => {
    const post = async (route: string, body: Record<string, unknown>) => {
      expect([route, body]).toEqual(["github/repos", { account: "acme_emu" }]);
      return SAMPLE;
    };
    expect(await fetchGitHubReposWith(post, { account: "acme_emu" })).toEqual({ ok: true, data: SAMPLE });
    expect((await fetchGitHubReposWith(async () => SAMPLE, { account: "../bad" })).ok).toBe(false);
    expect((await fetchGitHubReposWith(async () => ({ bad: true }))).ok).toBe(false);
    const kinds = [403, 403, 401, 503, 500].map(
      (s, i) => classifyGitHubReposFailure(s, undefined, i === 1 ? "revoked" : "not connected").kind,
    );
    expect(kinds).toEqual(["disconnected", "revoked", "unauthorized", "unavailable", "error"]);
    const p1 = { open: true, selected: [], maxSelected: 16, githubConnected: false, onSelect: () => {} };
    const html = renderToString(createElement(GitHubRepoPickerContent, p1));
    expect(html).toContain("GitHub is not connected");
    expect(html).toContain('href="/settings"');
    expect(html).toContain("focus-visible:ring-2");
    const p2 = { current: "vibe-co/armada", choices: CHOICES, onChange: () => {}, disabled: false };
    expect(renderToString(createElement(RepositoryPicker, p2))).toContain("vibe-co/armada");
    const p3 = { selected: ["vibe-co/armada"], maxSelected: 16, onSelect: () => {} };
    expect(renderToString(createElement(GitHubRepoPickerButton, p3))).toContain("Browse GitHub");
  });
});
