import { expect, test } from "bun:test";
import type { ResourceAdvice } from "@armada/core";
import { printOptionalResourceAdvice, resourceAdviceText } from "../src/resource-advice.ts";
import { createSdkCommandClient } from "../src/sdk-session.ts";
import { memorySessionStore } from "../src/session.ts";

const evidence: ResourceAdvice = {
  version: 1,
  scope: {
    ownerId: "owner",
    orgId: "org",
    goldenId: "golden",
    repositoryDir: "web",
    project: null,
    provider: "boat",
    workload: "codex",
    size: null,
  },
  generatedAt: "2026-11-09T16:00:00Z",
  window: { from: "2026-11-01T00:00:00Z", to: "2026-11-09T16:00:00Z", maxSessions: 10, considered: 10, sufficient: 8 },
  observations: {
    activeSeconds: 600,
    coverageFraction: 1,
    cpuAverageBusyCores: 0.2,
    cpuPeakBusyCores: 0.5,
    cpuPressureFraction: 0,
    cpuThrottledSeconds: 0,
    memoryPeakBytes: 1024 * 1024 * 512,
    oomKills: 0,
  },
  sampled: {
    capacity: null,
    points: 0,
    intervals: 0,
    allActivityCpuAverageBusyCores: null,
    allActivityCpuPeakBusyCores: null,
    memoryMaxObservedBytes: null,
    cpuPressureFraction: null,
    oomKills: null,
  },
  limitations: [],
  confidence: "moderate",
  reason: "headroom_observed",
  recommendedSize: "small",
};

test("human recommendation explains measured resources and comparable window without treating unknown as zero", () => {
  const text = resourceAdviceText(evidence);
  expect(text).toContain("small for future launches");
  expect(text).toContain("8/10 comparable sessions");
  expect(text).toContain("2026-11-01");
  expect(text).toContain("CPU peak 0.50 busy cores");
  expect(text).toContain("memory peak 512 MiB");
  expect(text).toContain("No running machine or default was changed");
  expect(
    resourceAdviceText({ ...evidence, observations: { ...evidence.observations, cpuPeakBusyCores: null } }),
  ).not.toContain("CPU peak");
  for (const reason of ["insufficient_sessions", "unknown_capacity", "collection_unavailable"] as const)
    expect(resourceAdviceText({ ...evidence, reason, recommendedSize: null })).toBeNull();
});

test("optional launch guidance uses actual advice route and fails open silently on missing or malformed telemetry", async () => {
  let err = "";
  const request = { id: "sandbox", org: "org" };
  const calls: { request: Request; signal: RequestInit["signal"] }[] = [];
  const cases = [
    { advice: evidence },
    null,
    { advice: { ...evidence, reason: "collection_unavailable", recommendedSize: null } },
    new Error("offline"),
  ];
  const client = await createSdkCommandClient({
    env: { ARMADA_TOKEN: "test_token" },
    session: memorySessionStore(),
    fetch: async (input, init) => {
      calls.push({ request: new Request(String(input), init), signal: init?.signal });
      const response = cases[calls.length - 1];
      if (response instanceof Error) throw response;
      return Response.json(response);
    },
  });
  for (const [index] of cases.entries()) {
    err = "";
    await printOptionalResourceAdvice(client, request.id, index === 0 ? request.org : undefined, (text) => {
      err += text;
    });
    if (index === 0) expect(err).toContain("Resource recommendation");
    else expect(err).toBe("");
  }
  expect(calls).toHaveLength(cases.length);
  for (const [index, { request: call, signal }] of calls.entries()) {
    expect(new URL(call.url).pathname).toBe("/api/v1/sandbox/advice");
    expect(call.method).toBe("POST");
    expect(await call.json()).toEqual(index === 0 ? request : { id: request.id });
    expect(signal).toBeInstanceOf(AbortSignal);
  }
});
