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
