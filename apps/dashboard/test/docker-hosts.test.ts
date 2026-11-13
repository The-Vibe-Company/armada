import { expect, test } from "bun:test";
import {
  type DockerHost,
  hasCheckedIn,
  hostName,
  hostRegistrationCommand,
  hostState,
  isRouteAbsent,
  parseDockerHostList,
  parseHostRegistration,
  revokeWarning,
} from "../src/lib/docker-hosts.ts";

const ID = "70bde9cd-36c9-40af-b15e-65b2f9d3c2a2";
const OTHER = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const host = (overrides: Partial<DockerHost> = {}): DockerHost => ({
  id: ID,
  name: null,
  state: "online",
  createdAt: "2026-11-13T08:00:00Z",
  lastSeenAt: "2026-11-13T11:59:50Z",
  revokedAt: null,
  sandboxes: 2,
  ...overrides,
});

test("the host list is read whole, and one malformed or duplicated host refuses the answer", () => {
  expect(parseDockerHostList({ placement: true, hosts: [host()] })).toEqual({ placement: true, hosts: [host()] });
  expect(parseDockerHostList({ placement: false, hosts: [] })).toEqual({ placement: false, hosts: [] });
  for (const bad of [
    null,
    { hosts: [] },
    { placement: true, hosts: [host({ state: "unknown" as DockerHost["state"] })] },
    { placement: true, hosts: [host({ id: "not-a-uuid" })] },
    { placement: true, hosts: [host({ sandboxes: -1 })] },
    { placement: true, hosts: [host({ state: "revoked" })] },
    { placement: true, hosts: [host({ revokedAt: "2026-11-13T09:00:00Z" })] },
    { placement: true, hosts: [host(), host()] },
  ])
    expect(parseDockerHostList(bad)).toBeNull();
});

test("a registration is a host ID and a 64-hex one-use token, nothing else", () => {
  const token = "a".repeat(64);
  expect(parseHostRegistration({ hostId: ID, registrationToken: token })).toEqual({
    hostId: ID,
    registrationToken: token,
  });
  expect(parseHostRegistration({ hostId: ID, registrationToken: "short" })).toBeNull();
  expect(parseHostRegistration({ hostId: "x", registrationToken: token })).toBeNull();
});

test("the command reads the token without echo on stdin, never in argv, and runs the daemon against the server origin", () => {
  const command = hostRegistrationCommand("https://armada.example.com/mcp?x=1");
  expect(command).toContain("read -rs token");
  expect(command).toContain(`printf '%s\\n' "$token" |`);
  expect(command).toContain("armada-docker-host register --server 'https://armada.example.com' --state-dir");
  expect(command).toContain('armada-docker-host run --state-dir "$HOME/.local/state/armada-docker-host"');
  expect(hostRegistrationCommand("ftp://armada.example.com")).toBeNull();
  expect(hostRegistrationCommand("https://user:pass@armada.example.com")).toBeNull();
  expect(hostRegistrationCommand("not a url")).toBeNull();
});

test("a host's state reads in plain words and an offline or unregistered host sorts first", () => {
  expect(hostState(host(), NOW)).toMatchObject({ bucket: "ready", tone: "success", label: "Online" });
  expect(hostState(host({ state: "offline", lastSeenAt: "2026-11-13T10:00:00Z" }), NOW)).toMatchObject({
    bucket: "action",
    label: "Last seen 2 hours ago",
  });
  expect(hostState(host({ state: "pending", lastSeenAt: null, createdAt: "2026-11-13T11:58:00Z" }), NOW)).toMatchObject(
    { bucket: "action", label: "Waiting for check-in" },
  );
  expect(hostState(host({ state: "pending", lastSeenAt: null }), NOW)).toMatchObject({
    bucket: "action",
    tone: "warning",
    label: "Registration expired",
  });
  expect(hostState(host({ state: "revoked", revokedAt: "2026-11-13T09:00:00Z" }), NOW)).toMatchObject({
    bucket: "rest",
    label: "Revoked",
  });
  expect(hostName(host())).toBe("Host 70bde9cd");
  expect(hostName(host({ name: "Workstation" }))).toBe("Workstation");
});

test("the dialog's host has checked in once it is listed online or offline, not while pending or revoked", () => {
  const list = (state: DockerHost["state"]) => ({
    placement: true,
    hosts: [host({ state, revokedAt: state === "revoked" ? "2026-11-13T09:00:00Z" : null })],
  });
  expect(hasCheckedIn(list("online"), ID)).toBe(true);
  expect(hasCheckedIn(list("offline"), ID)).toBe(true);
  expect(hasCheckedIn(list("pending"), ID)).toBe(false);
  expect(hasCheckedIn(list("revoked"), ID)).toBe(false);
  expect(hasCheckedIn(list("online"), OTHER)).toBe(false);
});

test("revoking warns that a revoked host can no longer clean up its sandboxes", () => {
  expect(revokeWarning(0)).not.toContain("delete");
  expect(revokeWarning(1)).toContain("It still has 1 sandbox: delete it first");
  expect(revokeWarning(3)).toContain("It still has 3 sandboxes: delete them first");
});

test("only an unmounted host route (404 or 405 without a code) reads as Docker not enabled", () => {
  expect(isRouteAbsent({ status: 404, code: undefined })).toBe(true);
  expect(isRouteAbsent({ status: 405, code: undefined })).toBe(true);
  expect(isRouteAbsent({ status: 404, code: "not_found" })).toBe(false);
  expect(isRouteAbsent({ status: 403, code: undefined })).toBe(false);
  expect(isRouteAbsent({ status: 503, code: undefined })).toBe(false);
  expect(isRouteAbsent({ status: undefined, code: undefined })).toBe(false);
});
