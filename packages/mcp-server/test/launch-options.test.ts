import { expect, test } from "bun:test";
import { type LaunchDiscoveryOptions, readLaunchOptions } from "../src/launch-options.ts";

const present = () => {
  throw new Error("Discovery must not invoke a launch service");
};
const launchServices = {
  boatLaunchEnabled: true,
  admitModalLaunch: present,
  templates: { command: present } as NonNullable<LaunchDiscoveryOptions["templates"]>,
  runtimeMcp: {} as NonNullable<LaunchDiscoveryOptions["runtimeMcp"]>,
  runtimeSend: present,
} satisfies LaunchDiscoveryOptions;

test("advertises Boat template MCP proof when ordinary runtime admission is enabled", () => {
  const result = readLaunchOptions(launchServices);
  expect(result.providers.find(({ id }) => id === "boat")?.capabilities.launch).toBe(true);
  expect(result.boatRuntime.opencodeMcpProofVersion).toBe(1);
});

test.each(["boatLaunchEnabled", "admitModalLaunch", "templates", "runtimeMcp", "runtimeSend"] as const)(
  "withholds Boat template MCP proof without %s",
  (missing) => {
    const { [missing]: _, ...options } = launchServices;
    expect(readLaunchOptions(options).boatRuntime.opencodeMcpProofVersion).toBe(0);
  },
);

test("does not advertise ordinary Boat launch from a runtime policy alone", () => {
  const options = { ...launchServices, boatLaunchEnabled: false, launch: { runtime: { start: present } } };
  const result = readLaunchOptions(options);
  expect(result.providers.find(({ id }) => id === "boat")?.capabilities.launch).toBe(false);
});
