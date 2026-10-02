import { expect, test } from "bun:test";
import type { Exec } from "../src/io.ts";
import { inspectProcess } from "../src/process.ts";

const command = "/usr/bin/node /usr/local/bin/armada watch --config /work/widgets/armada.toml";
const stat = (started: string) => `101 (node (watch)) S ${Array(18).fill("0").join(" ")} ${started} 0 0`;

test("Linux watch identity includes boot and kernel start ticks, handles parenthesized commands and fails closed", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (program, args) => {
    calls.push([program, ...args]);
    return { code: 0, stdout: `${command}\n`, stderr: "" };
  };
  const system = {
    platform: "linux",
    cwd: "/work/widgets",
    readFile: async (path: string) => (path.endsWith("boot_id") ? "synthetic-boot\n" : stat("500")),
    readlink: async () => "/work/widgets",
  };
  expect(await inspectProcess(exec, 101, system)).toEqual({
    started: "synthetic-boot/500",
    command,
    cwd: "/work/widgets",
  });
  expect(calls).toEqual([["ps", "-ww", "-p", "101", "-o", "command="]]);
  let reads = 0;
  expect(
    await inspectProcess(exec, 101, {
      ...system,
      readFile: async (path) => (path.endsWith("boot_id") ? "boot" : stat(String(++reads))),
    }),
  ).toBeNull();
  expect(
    await inspectProcess(exec, 101, {
      ...system,
      readlink: async () => {
        throw new Error("denied");
      },
    }),
  ).toBeNull();
  expect(await inspectProcess(exec, -1, system)).toBeNull();
});

test("macOS watch identity uses the exact ps command and start time and lsof's cwd, or stays unverified", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (program, args) => {
    calls.push([program, ...args]);
    return {
      code: 0,
      stderr: "",
      stdout:
        program === "lsof"
          ? "p101\nfcwd\nn/work/Widgets Fleet\n"
          : args.includes("lstart=")
            ? "Fri Oct  2 17:00:00 2026\n"
            : command,
    };
  };
  const system = {
    platform: "darwin",
    cwd: "/work/widgets",
    readFile: async () => {
      throw new Error("must not read proc on macOS");
    },
    readlink: async () => {
      throw new Error("must not read proc on macOS");
    },
  };
  expect(await inspectProcess(exec, 101, system)).toEqual({
    started: "Fri Oct  2 17:00:00 2026",
    command,
    cwd: "/work/Widgets Fleet",
  });
  expect(calls).toContainEqual(["lsof", "-a", "-p", "101", "-d", "cwd", "-Fn"]);
  expect(await inspectProcess(async () => ({ code: 1, stdout: "", stderr: "unavailable" }), 101, system)).toBeNull();
  expect(await inspectProcess(exec, 101, { ...system, platform: "unsupported" })).toBeNull();
});
