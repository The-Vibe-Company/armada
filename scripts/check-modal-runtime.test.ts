import { expect, test } from "bun:test";
import { scenarios } from "./fixtures/modal-runtime-scenarios";

// The real child owns environment/CLI parsing, allocation and unconditional cleanup.
// Labels are diagnostic only; transport defects and independent expected evidence
// are explicit data, so renaming a case cannot change its behaviour.
test.each(scenarios)("Modal one-allocation check is fail-closed ($label)", async (scenario) => {
  const variables = scenario.args.includes("--variables");
  const mcp = scenario.args.includes("--mcp");
  const github = scenario.args.includes("--github");
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      "./scripts/fixtures/modal-runtime-api.ts",
      "scripts/check-modal-runtime.ts",
      ...scenario.args,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ARMADA_MODAL_TEST_SCENARIO: JSON.stringify({ args: scenario.args, defects: scenario.defects }),
        ARMADA_RUNTIME_SMOKE: "one_real_modal_launch",
        ARMADA_URL: "https://staging.example",
        ARMADA_TOKEN: "fixture-token",
        ARMADA_RUNTIME_ORG: "org",
        ARMADA_RUNTIME_GOLDEN: "golden",
        ARMADA_RUNTIME_CREDENTIAL_ID: variables ? "33333333-3333-4333-8333-333333333333" : "account",
        ...(variables ? { ARMADA_RUNTIME_TEMPLATE_ID: "22222222-2222-4222-8222-222222222222" } : {}),
        ...(github ? { ARMADA_RUNTIME_GITHUB_REPOSITORY: "example/web" } : {}),
        ...(mcp
          ? {
              ARMADA_RUNTIME_MCP_CONNECTION_ID: "11111111-1111-4111-8111-111111111111",
              ARMADA_RUNTIME_MCP_TOOL: "read_counter",
              ARMADA_RUNTIME_MCP_EXPECT: "independent result",
              ARMADA_RUNTIME_MCP_ARGS_JSON: scenario.invalidMcpArgs
                ? "["
                : JSON.stringify({ nested: { b: 2, a: 1 }, label: "fixture" }),
            }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const expected = scenario.expected;
  expect(status === 0, stderr).toBe(expected.success);
  const ledger = (name: string): Record<string, number> =>
    JSON.parse(stdout.match(new RegExp(`${name} (.+)`))?.[1] ?? "null");
  expect(ledger("COUNTERS")).toEqual(expected.counters);
  if (expected.firstSends !== undefined) expect(ledger("IDLE").firstSends).toBe(expected.firstSends);
  if (expected.diskWrites !== undefined) expect(ledger("EMPTY").diskWrites).toBe(expected.diskWrites);
  if (expected.diskReads !== undefined) expect(ledger("EMPTY").diskReads).toBe(expected.diskReads);
  if (expected.skillStatuses !== undefined) expect(ledger("SKILLS").skillStatuses).toBe(expected.skillStatuses);
  if (expected.defaultReads !== undefined) expect(ledger("SKILLS").defaultReads).toBe(expected.defaultReads);
  if (expected.goldenReads !== undefined) expect(ledger("SKILLS").goldenReads).toBe(expected.goldenReads);
  if (expected.adjustedSkillStatuses !== undefined)
    expect(
      ledger("SKILLS").skillStatuses! -
        (variables && (scenario.args.includes("--idle") || scenario.args.includes("--empty-resume")) ? 1 : 0),
    ).toBe(expected.adjustedSkillStatuses);
  for (const [proof, verified] of Object.entries(expected.proofs))
    expect(stdout.includes(`"${proof}":"verified"`)).toBe(verified);
  for (const text of expected.stdoutContains ?? []) expect(stdout).toContain(text);
  for (const text of expected.stdoutExcludes ?? []) expect(stdout).not.toContain(text);
  for (const text of expected.stderrContains ?? []) expect(stderr).toContain(text);
  for (const text of expected.stderrExcludes ?? []) expect(stderr).not.toContain(text);
  for (const text of expected.combinedContains ?? []) expect(stdout + stderr).toContain(text);
  for (const text of expected.combinedExcludes ?? []) expect(stdout + stderr).not.toContain(text);
});
