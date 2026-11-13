import { expect, test } from "bun:test";
import { dashboardReadSmoke } from "./dashboard-read-smoke.ts";

const env = {
  ARMADA_URL: "https://staging.example.test",
  ARMADA_TOKEN: "test-only-bearer",
  ARMADA_SMOKE_CASES: JSON.stringify([{ org: "00000000-0000-4000-8000-000000000001" }]),
};
const sandbox = {
  id: "00000000-0000-4000-8000-000000000002",
  orgId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000003",
  provider: "modal",
  providerSandboxId: "sb-test",
  boatId: null,
  harness: "codex",
  model: null,
  reasoningEffort: null,
  status: "running",
  createdAt: "2026-11-13T00:00:00Z",
  stoppedAt: null,
  expiresAt: null,
  effectiveTtlSeconds: null,
  machineSize: "large",
  taskOutcome: null,
  preservationNote: null,
  displayLabel: "Smoke",
  canOpen: false,
  canManage: false,
};
function answer(url: string) {
  if (url.includes("/otto/")) return { items: [], observedAt: null, completeness: "unknown", nextCursor: null };
  if (url.endsWith("sandbox/list")) return { sandboxes: [sandbox], hasMore: false };
  if (url.endsWith("docker/hosts/list")) return { hosts: [], placement: false };
  return { providers: [{ id: "docker", enabled: false, launchSources: [], harnesses: [], capabilities: {} }] };
}
// Named verdicts are the smoke's boundary; the malformed row passes through the
// real dashboard parser rather than a mock parser or a source-text assertion.
test.each([
  ["healthy", "", undefined],
  [
    "malformed sandbox row (#1398)",
    "sandbox/list",
    { sandboxes: [{ ...sandbox, machineSize: "unexpected" }], hasMore: false },
  ],
  ["malformed host row", "docker/hosts/list", { hosts: [{}], placement: false }],
  ["malformed launch options", "launch/options", { providers: [{}] }],
  ["Otto error state", "otto/tasks", { error: "not logged" }],
] as const)("%s reports only the affected read", async (_name, broken, payload) => {
  const lines: { step: string; pass: boolean }[] = [];
  const passed = await dashboardReadSmoke(env, {
    now: () => 0,
    out: (line) => lines.push(JSON.parse(line)),
    fetch: async (url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${env.ARMADA_TOKEN}`);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json(broken && url.includes(broken) ? payload : answer(url));
    },
  });
  expect(passed).toBe(!broken);
  const failed = lines.filter((line) => !line.pass).map((line) => line.step);
  expect(failed).toEqual(
    broken
      ? [
          `dashboard_${broken === "sandbox/list" ? "sandboxes" : broken === "docker/hosts/list" ? "hosts" : broken === "launch/options" ? "launch_options" : "otto"}`,
        ]
      : [],
  );
  expect(lines).toHaveLength(5);
  expect(JSON.stringify(lines)).not.toContain(env.ARMADA_TOKEN);
});

test("sandbox pagination checks later malformed rows", async () => {
  const lines: { step: string; pass: boolean }[] = [];
  expect(
    await dashboardReadSmoke(env, {
      now: () => 0,
      out: (line) => lines.push(JSON.parse(line)),
      fetch: async (url, init) => {
        if (!url.endsWith("sandbox/list")) return Response.json(answer(url));
        const { page } = JSON.parse(String(init.body));
        return Response.json({ sandboxes: page === 1 ? [] : [{}], hasMore: page === 1 });
      },
    }),
  ).toBe(false);
  expect(lines.filter((line) => !line.pass)).toEqual([expect.objectContaining({ step: "dashboard_sandboxes" })]);
});

test.each(["http", "slow", "timeout"])("%s read fails without logging upstream text", async (mode) => {
  let now = 0;
  const lines: { step: string; pass: boolean; code?: string }[] = [];
  expect(
    await dashboardReadSmoke(env, {
      now: () => now,
      out: (line) => lines.push(JSON.parse(line)),
      fetch: async (url) => {
        if (url.endsWith("launch/options")) {
          if (mode === "timeout") throw new DOMException("secret upstream text", "TimeoutError");
          if (mode === "http") return new Response("secret upstream text", { status: 503 });
          const response = Response.json(answer(url));
          Object.defineProperty(response, "json", {
            value: async () => {
              now = 15_001;
              return answer(url);
            },
          });
          return response;
        }
        return Response.json(answer(url));
      },
    }),
  ).toBe(false);
  expect(lines).toContainEqual(
    expect.objectContaining({
      step: "dashboard_launch_options",
      pass: false,
      code: mode === "http" ? "http_failed" : "read_timeout",
    }),
  );
  expect(JSON.stringify(lines)).not.toContain("secret upstream text");
});

test.each([
  { ...env, ARMADA_TOKEN: "" },
  { ...env, ARMADA_URL: "https://user:password@example.test" },
  { ...env, ARMADA_SMOKE_CASES: "[]" },
])("invalid configuration never sends a bearer", async (config) => {
  let requests = 0;
  expect(
    await dashboardReadSmoke(config, {
      now: () => 0,
      out: () => {},
      fetch: async () => {
        requests++;
        throw new Error("must not reach network");
      },
    }),
  ).toBe(false);
  expect(requests).toBe(0);
});

test("dashboard reads ignore excluded Boat case configuration", async () => {
  const requests: string[] = [];
  expect(
    await dashboardReadSmoke(
      {
        ...env,
        ARMADA_SMOKE_CASES: JSON.stringify([
          { provider: "boat", org: "excluded-invalid-org" },
          ...JSON.parse(env.ARMADA_SMOKE_CASES),
        ]),
      },
      {
        now: () => 0,
        out: () => {},
        fetch: async (url) => {
          requests.push(url);
          return Response.json(answer(url));
        },
      },
    ),
  ).toBe(true);
  expect(requests.some((url) => url.includes("excluded-invalid-org"))).toBe(false);
});
