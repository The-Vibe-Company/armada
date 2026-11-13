import { expect, test } from "bun:test";
import {
  checkImage,
  DOCKER_CAPABILITIES,
  dockerLaunchBlocker,
  dockerLaunchBody,
  dockerLaunchOption,
  dockerUnavailable,
  launchedDockerSandbox,
} from "../src/lib/docker-launch.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const HOST = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const DIGEST = `buildpack-deps@sha256:${"5".repeat(64)}`;

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
  expect(option?.unsupportedReasons).toEqual({ resume: "Resume is not built for Docker yet." });
  expect(dockerLaunchOption({})).toBeNull();
  expect(dockerLaunchOption({ providers: [] })).toBeNull();
  expect(dockerLaunchOption(options({ capabilities: { launch: true } }))).toBeNull();
  expect(dockerLaunchOption(options({ harnesses: "codex" }))).toBeNull();
});

test("a host takes a launch only when the server launches Codex from an image on Docker and the host is online", () => {
  const ready = dockerLaunchOption(options());
  expect(dockerLaunchBlocker(ready, true, { state: "online" })).toBeNull();
  expect(dockerLaunchBlocker(null, true, { state: "online" })).toContain("does not launch on Docker");
  expect(dockerLaunchBlocker(ready, false, { state: "online" })).toContain("does not launch on Docker");
  const off = dockerLaunchOption(
    options({ capabilities: capabilities([]), unsupportedReasons: { launch: "Wired in the next increment." } }),
  );
  expect(dockerLaunchBlocker(off, true, { state: "online" })).toBe("Wired in the next increment.");
  expect(
    dockerLaunchBlocker(dockerLaunchOption(options({ harnesses: ["claude"] })), true, { state: "online" }),
  ).toContain("Codex from an image");
  expect(dockerLaunchBlocker(ready, true, { state: "offline" })).toBe("The host must be online to launch on it.");
  expect(dockerLaunchBlocker(ready, true, { state: "revoked" })).toBe("This host is revoked.");
});

test("what Docker cannot do yet is listed with the server's reason, or a plain default", () => {
  const unavailable = dockerUnavailable(dockerLaunchOption(options()) ?? fail());
  expect(unavailable).toContainEqual({ name: "Resume", reason: "Resume is not built for Docker yet." });
  expect(unavailable).toContainEqual({ name: "Follow-up messages", reason: "Not available on Docker hosts yet." });
  expect(unavailable.map((item) => item.name)).not.toContain("Stop");
  expect(unavailable.map((item) => item.name)).not.toContain("Launch");
});

test("only a digest-pinned image is accepted", () => {
  expect(checkImage(` ${DIGEST} `)).toEqual({ ok: true, image: DIGEST });
  expect(checkImage(`ghcr.io/org/image:tag@sha256:${"a".repeat(64)}`).ok).toBe(true);
  for (const bad of ["buildpack-deps:bookworm-curl", `x@sha256:${"a".repeat(63)}`, `x y@sha256:${"a".repeat(64)}`, ""])
    expect(checkImage(bad).ok).toBe(false);
});

test("the launch body is the normal route's Docker shape: Codex, private, the form key as requestId", () => {
  expect(
    dockerLaunchBody({
      org: ORG,
      hostId: HOST,
      image: DIGEST,
      credentialId: ACCOUNT,
      requestId: REQUEST,
      model: "gpt-5",
      reasoningEffort: "medium",
      prompt: "Say Hello",
    }),
  ).toEqual({
    org: ORG,
    provider: "docker",
    hostId: HOST,
    image: DIGEST,
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
      image: DIGEST,
      credentialId: ACCOUNT,
      requestId: "x",
      model: "m",
      reasoningEffort: "e",
    }),
  ).toThrow();
  expect(launchedDockerSandbox({ sandbox: { id: REQUEST, provider: "docker" } })).toBe(REQUEST);
  expect(launchedDockerSandbox({ sandbox: { id: REQUEST, provider: "boat" } })).toBeNull();
});

function fail(): never {
  throw new Error("expected a Docker option");
}
