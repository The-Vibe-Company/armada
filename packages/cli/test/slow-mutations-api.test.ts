import { expect, spyOn, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const cases = [
  ...["stop", "resume", "recover"].map((action) => ({
    name: `orchestrator ${action}`,
    args: [
      "orchestrator",
      action,
      "parent-1",
      "--org",
      "org-1",
      "--expected-revision",
      "7",
      "--idempotency-key",
      "original-key",
      "--json",
    ],
    path: `/api/v1/orchestrators/parent-1/${action}`,
    check: "armada orchestrator detail parent-1 --org org-1",
    response: { version: 1, id: "op-1", orchestratorId: "parent-1", kind: action, state: "succeeded", revision: 8 },
  })),
  {
    name: "sandbox stop",
    args: ["stop", "sandbox-1", "--json"],
    path: "/api/v1/sandbox/stop",
    check: "armada status sandbox-1",
    response: { stopped: true },
  },
];

// The fake server advances an injected deadline clock, with no real timers/network.
// These CLI-boundary cases own the long-mutation deadline and reconciliation contract.
test.each(cases)("$name survives slow success and reconciles a true timeout without replay", async (scenario) => {
  let now = 0;
  const timers: { at: number; controller: AbortController }[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    timers.push({ at: now + ms, controller });
    return controller.signal;
  });
  try {
    for (const duration of [310_000, 661_000]) {
      now = 0;
      timers.length = 0;
      let out = "";
      let err = "";
      const requests: Request[] = [];
      const auth = {
        env: { ARMADA_TOKEN: "fixture-token", ARMADA_URL: "https://armada.test" },
        session: memorySessionStore(),
        now: () => new Date(now),
        open: () => {},
        out: (text: string) => {
          out += text;
        },
        err: (text: string) => {
          err += text;
        },
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
          requests.push(request);
          expect(new URL(request.url).pathname).toBe(scenario.path);
          if (scenario.name.startsWith("orchestrator")) {
            expect(request.headers.get("idempotency-key")).toBe("original-key");
            expect(await request.json()).toEqual({ orgId: "org-1", expectedRevision: 7 });
          }
          now += duration;
          for (const timer of timers) {
            if (timer.at <= now) timer.controller.abort(new DOMException("Deadline", "TimeoutError"));
          }
          request.signal.throwIfAborted();
          return Response.json(scenario.response);
        },
      };
      const code = await run(scenario.args, auth, { auth });
      expect(requests).toHaveLength(1);
      if (duration === 310_000) {
        expect({ code, err }).toEqual({ code: 0, err: "" });
        expect(JSON.parse(out)).toEqual(scenario.response);
      } else {
        expect(code).toBe(1);
        const message = JSON.parse(err).error.message;
        expect(message).toContain("The server did not answer in time; the operation may have been accepted.");
        expect(message).toContain(scenario.check);
        expect(message).not.toContain("could not reach");
        if (scenario.name.startsWith("orchestrator")) expect(message).toContain("same idempotency key");
      }
    }
  } finally {
    timeout.mockRestore();
  }
});
