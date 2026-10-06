import { expect, test } from "bun:test";
import { type AcceptanceRunner, allowAcceptance, runAcceptance } from "../src/acceptance.ts";
import { parseConfig } from "../src/config.ts";
import { acceptancePasses } from "../src/phases.ts";
import type { WorkerContext } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, fakeClock, NOW } from "./support.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
function setup() {
  const clock = fakeClock(NOW);
  const linear = new FakeLinear(clock.now);
  const config = parseConfig(
    `${DEMO_TOML}\n[[acceptance]]\nname = "prod_build"\ncommand = "build"\ntimeout_minutes = 20`,
  );
  linear.add("DEMO-7", {
    labels: [{ id: "phase-shipping", name: "shipping", group: config.tracker.labels.phaseGroup }],
    prs: [{ number: 9, url: "https://github.com/acme/widgets/pull/9", repo: "acme/widgets", title: "build" }],
  });
  const ctx: WorkerContext = {
    config,
    linear,
    now: clock.now,
    fleet: async () => ({ fleet: null, warning: "Armada down" }),
    readPull: async () => ({
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      repo: "acme/widgets",
      title: "build",
      state: "open",
      headSha: HEAD,
    }),
  };
  let executions = 0;
  const runner: AcceptanceRunner = {
    checkHead: async () => {},
    run: async () => {
      executions++;
      clock.advance(192_000);
      return { ok: true, output: "ok" };
    },
  };
  return { ctx, linear, runner, count: () => executions };
}

test("Linear attempts enforce the per-check cap, and only a coordinator can grant more", async () => {
  const { ctx, linear, runner, count } = setup();
  for (let i = 0; i < 3; i++) expect((await runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).ok).toBe(true);
  expect(acceptancePasses(linear.get("DEMO-7").comments).checks[0]).toEqual({
    name: "prod_build",
    runs: 3,
    passed: [HEAD],
  });
  expect(linear.bodies.some((b) => b.includes(`passed on ${HEAD} in 3m12s`))).toBe(true);
  await expect(runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).rejects.toThrow("ask the coordinator");
  expect(count()).toBe(3);
  ctx.workerSession = true;
  await expect(allowAcceptance(ctx, { ticket: "DEMO-7", runs: 2, reason: "head updated" })).rejects.toThrow(
    "only the coordinator",
  );
  ctx.workerSession = false;
  await allowAcceptance(ctx, { ticket: "DEMO-7", runs: 2, reason: "head updated" });
  expect((await runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).ok).toBe(true);
  expect(count()).toBe(4);
});

test("dirty/head mismatches refuse before spending; failed and interrupted attempts spend a run", async () => {
  const { ctx, linear, runner, count } = setup();
  const before = linear.writes.length;
  await expect(
    runAcceptance(
      ctx,
      { ticket: "DEMO-7" },
      {
        ...runner,
        checkHead: async () => {
          throw new Error("dirty");
        },
      },
    ),
  ).rejects.toThrow("dirty");
  expect(linear.writes.length).toBe(before);
  expect(count()).toBe(0);
  runner.run = async () => ({
    ok: false,
    output: `${Array.from({ length: 60 }, (_, i) => `error ${i}`).join("\n")}\nTimed out`,
  });
  expect((await runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).ok).toBe(false);
  const body = linear.bodies.at(-1) ?? "";
  expect(body).toContain(`failed on ${HEAD}`);
  expect(body).toContain("> error 22");
  expect(body).not.toContain("> error 0");
  expect(body).toContain("> Timed out");
  linear.post(
    "DEMO-7",
    `Agent status: shipping — acceptance "prod_build" started on ${HEAD} (run 2/3)`,
    NOW.toISOString(),
  );
  expect(acceptancePasses(linear.get("DEMO-7").comments).checks[0]?.runs).toBe(2);
  linear.get("DEMO-7").commentsTruncated = true;
  await expect(runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).rejects.toThrow("counts are incomplete");
});

test("a moving PR or a checkout modified by the command cannot yield a pass", async () => {
  const { ctx, linear, runner } = setup();
  let reads = 0;
  ctx.readPull = async () => ({
    number: 9,
    url: "https://github.com/acme/widgets/pull/9",
    repo: "acme/widgets",
    title: "build",
    headSha: ++reads === 1 ? HEAD : "f".repeat(40),
  });
  expect((await runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).ok).toBe(false);
  expect(acceptancePasses(linear.get("DEMO-7").comments).checks[0]?.passed).toEqual([]);
  ctx.readPull = async () => ({
    number: 9,
    url: "https://github.com/acme/widgets/pull/9",
    repo: "acme/widgets",
    title: "build",
    headSha: HEAD,
  });
  let checks = 0;
  runner.checkHead = async () => {
    if (++checks === 2) throw new Error("dirty");
  };
  expect((await runAcceptance(ctx, { ticket: "DEMO-7" }, runner)).ok).toBe(false);
  expect(acceptancePasses(linear.get("DEMO-7").comments).checks[0]?.passed).toEqual([]);
});
