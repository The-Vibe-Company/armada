import { mock } from "bun:test";
import { FakeLinear, NOW } from "../../../core/test/support.ts";
import { type Io, run } from "../../src/cli.ts";

const runCli = run;

mock.module("../../src/cli.ts", () => ({
  run: async (argv: string[], io: Io) => {
    const linear = new FakeLinear();
    linear.add("DEMO-7", {
      statusType: "started",
      stateId: "st-started",
      labels: [{ id: "phase-implementing", name: "implementing", group: "Agent phase" }],
    });
    const code = await runCli(argv, {
      ...io,
      now: () => NOW,
      readStdin: async () => {
        io.stdout("Reading standard input.\n");
        return (await io.readStdin?.()) ?? "";
      },
      linearWriter: () => linear,
      fetch: async () => {
        throw new Error("unexpected network request");
      },
    });
    io.stdout(`${JSON.stringify({ bodies: linear.bodies, writes: linear.writes })}\n`);
    return code;
  },
}));
