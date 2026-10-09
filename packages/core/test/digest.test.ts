import { expect, test } from "bun:test";
import { buildDigest, renderDigest } from "../src/digest.ts";
import { tempFleet } from "./support.ts";

test("digest reads and sends reject worker sessions; sends without a configured channel explain the next step", async () => {
  const worker = tempFleet({ caller: { kind: "worker", ticket: "WID-2" } });
  await expect(worker.fleet.digest({ since: null })).rejects.toThrow("worker session");
  await expect(worker.fleet.sendDigest({ since: null })).rejects.toThrow("worker session");
  const organization = tempFleet();
  await expect(organization.fleet.sendDigest({ since: null })).rejects.toThrow("Notifications");
});

test("owner digest preserves titles, durations and links, translates fixed text and qualifies sampled estimates", () => {
  const since = "2026-04-06T09:00:00.000Z";
  const now = new Date("2026-04-06T13:00:00.000Z");
  const input = {
    since,
    until: now.toISOString(),
    now,
    summary: {
      since,
      merged: [{ project: "widgets", ticket: "WID-2", at: now.toISOString() }],
      started: [],
      stuck: [{ project: "widgets", ticket: "WID-3", reason: "blocked" as const, minutes: 40, ongoing: true }],
      waiting: [{ project: "widgets", ticket: "WID-4", id: 7, kind: "validation" as const }],
      quiet: false,
    },
    titles: { "widgets/WID-2": "Export the report" },
    inFlight: [
      {
        project: "widgets",
        ticket: "WID-5",
        title: "Add search",
        phase: "implementing" as const,
        phaseSince: "2026-04-06T12:50:00.000Z",
      },
    ],
    phaseMedians: { implementing: 20 * 60_000, shipping: 15 * 60_000, "ready-to-merge": 5 * 60_000 },
    mergedSamples: 3,
  };
  const digest = buildDigest(input);
  expect(digest.inFlight[0]?.remainingMinutes).toBe(30);
  const options = { format: "plain" as const, appUrl: "https://armada.example.test" };
  expect(renderDigest(digest, { ...options, language: "en" })).toMatchInlineSnapshot(`
"Fleet summary · 2026-04-06 09:00–2026-04-06 13:00 UTC

Merged
• WID-2 · Export the report

Stuck or blocked
• WID-3 · blocked · 40 min

Waiting for you
• WID-4 · work to validate · https://armada.example.test/approve/7

In progress
• WID-5 · Add search · implementing · usually ~30 min more"
`);
  expect(renderDigest(digest, { ...options, language: "fr" })).toMatchInlineSnapshot(`
"Résumé de la flotte · 2026-04-06 09:00–2026-04-06 13:00 UTC

Fusionnés
• WID-2 · Export the report

Bloqués ou sans nouvelles
• WID-3 · bloqué · 40 min

En attente de votre décision
• WID-4 · travail à valider · https://armada.example.test/approve/7

En cours
• WID-5 · Add search · réalisation · habituellement ~30 min de plus"
`);
  expect(buildDigest({ ...input, mergedSamples: 2 }).inFlight[0]?.remainingMinutes).toBeNull();
  expect(buildDigest({ ...input, phaseMedians: {} }).inFlight[0]?.remainingMinutes).toBeNull();
  const quiet = buildDigest({ ...input, summary: { ...input.summary, merged: [], stuck: [], waiting: [] } });
  expect(renderDigest(quiet, { ...options, language: "fr" })).toBe(
    "Rien de nouveau : aucune fusion, aucun blocage, aucune décision en attente.",
  );
  const unsafe = buildDigest({ ...input, titles: { "widgets/WID-2": "<&channel>\n*forged*" } });
  expect(renderDigest(unsafe, { ...options, language: "en", format: "slack" })).not.toContain("<&channel>");
});

test("digest groups work by spec and preserves deploy targets and free-text job progress in text and JSON", () => {
  const now = new Date("2026-04-06T13:00:00Z");
  const since = "2026-04-06T09:00:00Z";
  const group = (key: string, title: string, done: number, total: number) => ({ key, title, done, total });
  const digest = buildDigest({
    since,
    until: now.toISOString(),
    now,
    summary: {
      since,
      quiet: false,
      started: [],
      stuck: [],
      merged: [
        { project: "widgets", ticket: "WID-10", at: now.toISOString() },
        { project: "widgets", ticket: "WID-2", at: now.toISOString() },
        { project: "widgets", ticket: "WID-99", at: now.toISOString() },
      ],
      waiting: [{ project: "widgets", ticket: "WID-10", id: 7, kind: "validation" }],
    },
    groups: {
      "widgets/WID-10": group("widgets/spec-10", "Spec 10 · Ship & <verify>\nnow", 1, 2),
      "widgets/WID-2": group("widgets/spec-2", "Spec 2 · Search", 7, 10),
    },
    inFlight: [
      { project: "widgets", ticket: "WID-2", title: "Search images", phase: "implementing", phaseSince: since },
    ],
    phaseMedians: {},
    extras: {
      deploys: [{ project: "widgets", target: "production", state: "failure", url: "/projects/widgets" }],
      jobs: [
        {
          project: "widgets",
          ticket: "WID-2",
          title: "Search images",
          progress: "40/120 <items>\nnow",
          eta: "2026-04-06T15:00:00Z",
          url: "/agents/WID-2",
        },
      ],
    },
  });
  const options = { language: "en" as const, format: "plain" as const, appUrl: "https://armada.example.test" };
  const text = renderDigest(digest, options);
  expect(text).toContain(
    "Merged\nSpec 2 · Search (7/10)\n• WID-2\nSpec 10 · Ship & <verify> now (1/2)\n• WID-10\nOther\n• WID-99",
  );
  expect(text).toContain(
    "Waiting for you\nSpec 10 · Ship & <verify> now (1/2)\n• WID-10 · work to validate · https://armada.example.test/approve/7",
  );
  expect(text).toContain("In progress\nSpec 2 · Search (7/10)");
  expect(text).toContain("Deployments\n• widgets · production · failed · https://armada.example.test/projects/widgets");
  expect(text).toContain("40/120 <items> now · ETA 2026-04-06 15:00 UTC · https://armada.example.test/agents/WID-2");
  expect(text).not.toContain("40/120%");
  const slack = renderDigest(digest, { ...options, format: "slack" });
  expect(slack).toContain("Spec 10 · Ship &amp; &lt;verify&gt; now (1/2)");
  expect(slack).toContain("40/120 &lt;items&gt; now");
  expect(slack).toContain(
    "<https://armada.example.test/projects/widgets|https://armada.example.test/projects/widgets>",
  );
  expect(renderDigest(digest, { ...options, language: "fr" })).toContain("Autres\n• WID-99");
  const json = JSON.parse(JSON.stringify(digest));
  expect(json.extras.jobs[0].progress).toBe("40/120 <items>\nnow");
  expect(json.groups["widgets/WID-2"]).toMatchObject({ done: 7, total: 10 });
  const single = { ...digest, summary: { ...digest.summary, merged: [], waiting: [] } };
  expect(renderDigest(single, options)).not.toContain("Spec 2");
  expect(renderDigest({ ...digest, groups: undefined }, options)).not.toContain("Other");
  const healthyOnly = buildDigest({
    since,
    until: now.toISOString(),
    now,
    summary: { since, merged: [], started: [], stuck: [], waiting: [], quiet: true },
    inFlight: [],
    phaseMedians: {},
    extras: { deploys: [{ project: "widgets", target: "production", state: "success", url: "/projects/widgets" }] },
  });
  expect(healthyOnly.quiet).toBe(false);
  expect(renderDigest(healthyOnly, options)).toContain("production · successful");
});
