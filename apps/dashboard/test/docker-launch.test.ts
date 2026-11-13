import { expect, test } from "bun:test";
import { DOCKER_DEFAULT_IMAGE } from "@armada/core";
import { launchProviderOptions } from "../../../packages/mcp-server/src/launch-options.ts";
import {
  DOCKER_CAPABILITIES,
  dockerHarnesses,
  dockerImageLabel,
  dockerLaunchBlocker,
  dockerLaunchBody,
  dockerLaunchOption,
  dockerSandboxControls,
  dockerUnavailable,
  launchedDockerSandbox,
  preferredHarness,
} from "../src/lib/docker-launch.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";

const capabilities = (on: string[]) => Object.fromEntries(DOCKER_CAPABILITIES.map((name) => [name, on.includes(name)]));
const options = (docker: Record<string, unknown> = {}) => ({
  providers: [
    { id: "boat", enabled: true, launchSources: ["golden"], harnesses: ["claude"], capabilities: {} },
    {
      id: "docker",
      enabled: true,
      launchSources: ["image"],
      harnesses: ["codex"],
      capabilities: capabilities(["launch", "stop", "delete"]),
      unsupportedReasons: { resume: "Resume is not built for Docker yet.", followupPrompts: 3 },
      ...docker,
    },
  ],
});

test("the Docker launch option is read strictly from launch/options; anything unexpected means no launch", () => {
  const option = dockerLaunchOption(options());
  expect(option?.capabilities.launch).toBe(true);
  expect(dockerLaunchOption(options({ capabilities: { launch: true, secrets: true } }))?.capabilities.secrets).toBe(
    true,
  );
  expect(dockerLaunchOption(options({ capabilities: { launch: true } }))?.capabilities.secrets).toBe(false);
  expect(dockerLaunchOption(options({ capabilities: { launch: true, variables: true } }))?.capabilities.variables).toBe(
    true,
  );
  expect(dockerLaunchOption(options({ capabilities: { launch: true } }))?.capabilities.variables).toBe(false);
  expect(option?.unsupportedReasons).toEqual({ resume: "Resume is not built for Docker yet." });
  expect(dockerLaunchOption({})).toBeNull();
  expect(dockerLaunchOption({ providers: [] })).toBeNull();
  expect(dockerLaunchOption(options({ capabilities: { launch: "yes" } }))).toBeNull();
  expect(dockerLaunchOption(options({ harnesses: "codex" }))).toBeNull();
  // A newer server's unknown values are ignored; a capability it does not name is unsupported.
  const newer = dockerLaunchOption(options({ harnesses: ["codex", "future"], launchSources: ["image", "snapshot"] }));
  expect(newer?.harnesses).toEqual(["codex"]);
  expect(newer?.launchSources).toEqual(["image"]);
  expect(dockerLaunchOption(options({ capabilities: { stop: true } }))?.capabilities).toMatchObject({
    stop: true,
    launch: false,
    logs: false,
  });
});

test("a host takes a launch only when the server launches an agent in the official Armada environment on Docker and the host is online", () => {
  const ready = dockerLaunchOption(options());
  expect(dockerLaunchBlocker(ready, true, { state: "online" })).toBeNull();
  expect(dockerLaunchBlocker(null, true, { state: "online" })).toContain("does not launch on Docker");
  expect(dockerLaunchBlocker(ready, false, { state: "online" })).toContain("does not launch on Docker");
  const off = dockerLaunchOption(
    options({ capabilities: capabilities([]), unsupportedReasons: { launch: "Wired in the next increment." } }),
  );
  expect(dockerLaunchBlocker(off, true, { state: "online" })).toBe("Wired in the next increment.");
  // Before the normal launch ships, placement is false too: the server's own reason is still what is said.
  expect(dockerLaunchBlocker(off, false, { state: "online" })).toBe("Wired in the next increment.");
  expect(
    dockerLaunchBlocker(dockerLaunchOption(options({ harnesses: ["claude"] })), true, { state: "online" }),
  ).toBeNull();
  expect(dockerLaunchBlocker(dockerLaunchOption(options({ harnesses: [] })), true, { state: "online" })).toContain(
    "an agent in the official Armada environment",
  );
  expect(dockerLaunchBlocker(ready, true, { state: "offline" })).toBe("The host must be online to launch on it.");
  expect(dockerLaunchBlocker(ready, true, { state: "revoked" })).toBe("This host is revoked.");
  expect(dockerLaunchBlocker(null, false, { state: "revoked" })).toBe("This host is revoked.");
});

test("what Docker cannot do yet is listed with the server's reason, or a plain default", () => {
  const unavailable = dockerUnavailable(dockerLaunchOption(options()) ?? fail());
  expect(unavailable).toContainEqual({ name: "Resume", reason: "Resume is not built for Docker yet." });
  expect(unavailable).toContainEqual({ name: "Follow-up messages", reason: "Not available on Docker hosts yet." });
  expect(unavailable.map((item) => item.name)).not.toContain("Stop");
  expect(unavailable.map((item) => item.name)).not.toContain("Launch");
});

test("the dialog offers the agents the server launches on Docker, Codex chosen first when offered", () => {
  expect(dockerHarnesses(dockerLaunchOption(options({ harnesses: ["opencode", "codex", "claude"] })))).toEqual({
    offered: ["claude", "codex", "opencode"],
    initial: "codex",
  });
  expect(dockerHarnesses(dockerLaunchOption(options({ harnesses: ["opencode", "claude"] })))).toEqual({
    offered: ["claude", "opencode"],
    initial: "claude",
  });
  expect(dockerHarnesses(null)).toEqual({ offered: [], initial: null });
  const all = ["claude", "codex", "opencode"] as const;
  expect(preferredHarness(all, "codex", () => true)).toBe("codex");
  expect(preferredHarness(all, "codex", (agent) => agent === "opencode")).toBe("opencode");
  expect(preferredHarness(all, "codex", () => false)).toBe("codex");
  expect(preferredHarness(["claude"], "codex", () => false)).toBe("claude");
});

test("the launch body omits image overrides: the chosen agent, private, the form key as requestId", () => {
  expect(
    dockerLaunchBody({
      org: ORG,
      hostId: HOST,
      harness: "codex",
      credentialId: ACCOUNT,
      requestId: REQUEST,
      model: "gpt-5",
      reasoningEffort: "medium",
      prompt: "Say Hello",
    }),
  ).toStrictEqual({
    org: ORG,
    provider: "docker",
    hostId: HOST,
    harness: "codex",
    credentialId: ACCOUNT,
    requestId: REQUEST,
    model: "gpt-5",
    reasoningEffort: "medium",
    visibility: "private",
    prompt: "Say Hello",
  });
  expect(() =>
    dockerLaunchBody({
      org: ORG,
      hostId: HOST,
      harness: "codex",
      credentialId: ACCOUNT,
      requestId: "x",
      model: "m",
      reasoningEffort: "e",
    }),
  ).toThrow();
  expect(
    dockerLaunchBody({
      org: ORG,
      hostId: HOST,
      harness: "claude",
      credentialId: ACCOUNT,
      requestId: REQUEST,
      model: "m",
      reasoningEffort: "e",
    }).harness,
  ).toBe("claude");
  expect(launchedDockerSandbox({ sandbox: { id: REQUEST, provider: "docker" } })).toBe(REQUEST);
  expect(launchedDockerSandbox({ sandbox: { id: REQUEST, provider: "boat" } })).toBeNull();
});

function fail(): never {
  throw new Error("expected a Docker option");
}

test("a Docker sandbox's page offers only what the server supports, and gives the server's reason for the rest", () => {
  const option = dockerLaunchOption(
    options({
      capabilities: capabilities(["logs", "status", "stop", "delete"]),
      unsupportedReasons: { followupPrompts: "Docker follow-up prompts are not available yet." },
    }),
  );
  const controls = dockerSandboxControls(option);
  expect(controls.reasons.logs).toBeUndefined();
  expect(controls.reasons.stop).toBeUndefined();
  expect(controls.reasons.delete).toBeUndefined();
  expect(controls.reasons.followupPrompts).toBe("Docker follow-up prompts are not available yet.");
  expect(controls.reasons.resume).toBe("Not available on Docker hosts yet.");
  expect(controls.unavailable.map((item) => item.name)).toEqual([
    "Follow-up messages",
    "Steering",
    "Interrupt",
    "Resume",
    "Commands",
  ]);
  // No readable option: nothing is offered, every control says why.
  const unknown = dockerSandboxControls(null);
  expect(unknown.reasons.stop).toContain("could not be read");
  expect(unknown.reasons.logs).toContain("could not be read");
});

test("the server's own launch options drive the Docker sandbox page and the launch, enabled or not", () => {
  const off = dockerLaunchOption({ providers: launchProviderOptions({}) });
  expect(off?.enabled).toBe(false);
  expect(dockerSandboxControls(off).reasons.stop).toBe("Docker hosts are not enabled on this server.");

  const controls = dockerLaunchOption({ providers: launchProviderOptions({ hosts: true, normalApi: true }) });
  const page = dockerSandboxControls(controls);
  expect(page.reasons.logs).toBeUndefined();
  expect(page.reasons.stop).toBeUndefined();
  expect(page.reasons.delete).toBeUndefined();
  expect(page.reasons.followupPrompts).toBeString();
  expect(dockerLaunchBlocker(controls, false, { state: "online" })).toBeString();

  const launch = dockerLaunchOption({
    providers: launchProviderOptions({ hosts: true, normalApi: true, placement: true, normalLaunch: true }),
  });
  expect(dockerLaunchBlocker(launch, true, { state: "online" })).toBeNull();
});

test("a Docker sandbox's image reads as a name, with the full reference kept for its tooltip", () => {
  const DIGEST = `buildpack-deps@sha256:${"b".repeat(64)}`;
  expect(dockerImageLabel(DOCKER_DEFAULT_IMAGE)).toEqual({ label: "Armada default", detail: DOCKER_DEFAULT_IMAGE });
  expect(dockerImageLabel(DIGEST)).toEqual({ label: "buildpack-deps", detail: DIGEST });
  expect(dockerImageLabel(`sha256:${"a".repeat(64)}`)).toMatchObject({ label: `Local image ${"a".repeat(12)}` });
  expect(dockerImageLabel(null)).toEqual({ label: "Unknown", detail: null });
});
