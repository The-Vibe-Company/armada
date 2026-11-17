import { expect, test } from "bun:test";
import {
  connectedHostName,
  type DockerHost,
  dockerHostActionFailure,
  dockerHostLimitsInput,
  expiryCountdown,
  hostBuildBlocker,
  hostFact,
  hostName,
  hostNameInput,
  hostState,
  isRouteAbsent,
  parseDockerHostList,
  parseHostRegistration,
  revokeWarning,
  sandboxHostLabel,
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
  version: "1.4.0",
  ...overrides,
});

test("one malformed host is left out and counted; a bad envelope or a duplicated host refuses the answer", () => {
  expect(parseDockerHostList({ placement: true, hosts: [host()] })).toEqual({
    placement: true,
    hosts: [host()],
    skipped: 0,
  });
  expect(parseDockerHostList({ placement: false, hosts: [] })).toEqual({ placement: false, hosts: [], skipped: 0 });
  for (const broken of [
    host({ state: "unknown" as DockerHost["state"] }),
    host({ id: "not-a-uuid" }),
    host({ sandboxes: -1 }),
    host({ state: "revoked" }),
    host({ revokedAt: "2026-11-13T09:00:00Z" }),
  ])
    expect(parseDockerHostList({ placement: true, hosts: [broken, host()] })).toEqual({
      placement: true,
      hosts: [host()],
      skipped: 1,
    });
  for (const bad of [null, { hosts: [] }, { placement: true, hosts: [host(), host()] }])
    expect(parseDockerHostList(bad)).toBeNull();
});

test("a registration is a host ID, a one-line command and an expiry, nothing stored as a bare token", () => {
  const command = "curl -fsSL https://armada.example.com/install-host.sh | sh -s -- --token abc";
  const expiresAt = "2026-11-13T12:05:00Z";
  expect(parseHostRegistration({ hostId: ID, command, expiresAt })).toEqual({ hostId: ID, command, expiresAt });
  // Surrounding whitespace is trimmed; the command itself may not span lines.
  expect(parseHostRegistration({ hostId: ID, command: `  ${command}  `, expiresAt })?.command).toBe(command);
  for (const bad of [
    { hostId: "x", command, expiresAt },
    { hostId: ID, command: "", expiresAt },
    { hostId: ID, command: "a\nb", expiresAt },
    { hostId: ID, command: `x${"y".repeat(3000)}`, expiresAt },
    { hostId: ID, command, expiresAt: "soon" },
    { hostId: ID, command },
  ])
    expect(parseHostRegistration(bad)).toBeNull();
});

test("an optional host name is trimmed, blank becomes none, and an over-long name is refused", () => {
  expect(hostNameInput("  ")).toEqual({ ok: true, name: null });
  expect(hostNameInput("  build-box ")).toEqual({ ok: true, name: "build-box" });
  expect(hostNameInput("x".repeat(65))).toMatchObject({ ok: false });
});

test("the expiry counts down as m:ss and reads expired once it passes", () => {
  const expiresAt = "2026-11-13T12:05:00Z";
  expect(expiryCountdown(expiresAt, NOW)).toBe("5:00");
  expect(expiryCountdown(expiresAt, NOW + 211_000)).toBe("1:29");
  expect(expiryCountdown(expiresAt, NOW + 300_000)).toBeNull();
  expect(expiryCountdown(expiresAt, NOW + 600_000)).toBeNull();
});

test("old servers ask for an update instead of inventing running counts", () => {
  expect(hostFact({ sandboxes: 2, version: "1.4.0" })).toBe(
    "Update the server to report running sandboxes and limits.",
  );
});

test("a host's reported daemon version is parsed; a blank or missing one reads as unknown", () => {
  expect(parseDockerHostList({ placement: true, hosts: [host({ version: "1.4.0" })] })?.hosts[0]?.version).toBe(
    "1.4.0",
  );
  expect(
    parseDockerHostList({ placement: true, hosts: [host({ version: "  " } as Partial<DockerHost>)] })?.hosts[0]
      ?.version,
  ).toBeNull();
  expect(
    parseDockerHostList({ placement: true, hosts: [host({ version: undefined } as Partial<DockerHost>)] })?.hosts[0]
      ?.version,
  ).toBeNull();
});

test("a host's state reads in plain words and an offline or unregistered host sorts first", () => {
  expect(hostState(host(), NOW)).toMatchObject({ bucket: "ready", tone: "success", label: "Online" });
  expect(hostState(host({ state: "offline", lastSeenAt: "2026-11-13T10:00:00Z" }), NOW)).toMatchObject({
    bucket: "action",
    label: "Offline",
    detail: "Last seen 2 hours ago. Check that the machine is on and Docker is running.",
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
    label: "Unlinked",
  });
  expect(hostState(host({ state: "draining" }), NOW)).toMatchObject({
    bucket: "action",
    tone: "warning",
    label: "Draining",
  });
  expect(hostState(host({ state: "draining" }), NOW).detail).toContain("uninstall");
  expect(hostBuildBlocker({ state: "online" })).toBeNull();
  expect(hostBuildBlocker({ state: "draining" })).toContain("draining for uninstall");
  expect(hostBuildBlocker({ state: "offline" })).toBe("Bring this server online to build.");
  expect(hostName(host())).toBe("Unnamed server");
  expect(hostName(host({ name: "Workstation" }))).toBe("Workstation");
});

test("the dialog's host is connected, with its name, once listed online or offline, not while pending or revoked", () => {
  const list = (state: DockerHost["state"]) => ({
    placement: true,
    hosts: [host({ state, name: "build-box", revokedAt: state === "revoked" ? "2026-11-13T09:00:00Z" : null })],
    skipped: 0,
  });
  expect(connectedHostName(list("online"), ID)).toBe("build-box");
  expect(connectedHostName(list("offline"), ID)).toBe("build-box");
  expect(connectedHostName(list("pending"), ID)).toBeNull();
  expect(connectedHostName(list("revoked"), ID)).toBeNull();
  expect(connectedHostName(list("online"), OTHER)).toBeNull();
});

test("revoking warns that a revoked host can no longer clean up its sandboxes", () => {
  expect(revokeWarning(0)).toContain("run the uninstall command there first");
  expect(revokeWarning(1)).toContain("Stop its 1 sandbox first");
  expect(revokeWarning(3)).toContain("Stop its 3 sandboxes first");
});

test("only an unmounted host route (404 or 405 without a code) reads as Docker not enabled", () => {
  expect(isRouteAbsent({ status: 404, code: undefined })).toBe(true);
  expect(isRouteAbsent({ status: 405, code: undefined })).toBe(true);
  expect(isRouteAbsent({ status: 404, code: "not_found" })).toBe(false);
  expect(isRouteAbsent({ status: 403, code: undefined })).toBe(false);
  expect(isRouteAbsent({ status: 503, code: undefined })).toBe(false);
  expect(isRouteAbsent({ status: undefined, code: undefined })).toBe(false);
});

test("a Docker sandbox page names its host in short, readable words", () => {
  const list = { placement: true, hosts: [host({ name: "stan-oneclick" })], skipped: 0 };
  expect(sandboxHostLabel(list, ID)).toBe("stan-oneclick");
  expect(sandboxHostLabel(list, OTHER)).toBe("Host 11111111");
  expect(sandboxHostLabel(null, ID)).toBe("Host 70bde9cd");
  expect(sandboxHostLabel(list, null)).toBe("Unknown");
});

test("resource observations survive parsing while malformed capacity data is excluded", () => {
  const resources = {
    machine: { cpus: 8, memoryBytes: 26 * 1024 ** 3 },
    perSandbox: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 4096 },
    capacity: 6,
    mode: "automatic" as const,
  };
  const value = host({ running: 3, resources });
  const parsed = parseDockerHostList({ placement: true, hosts: [value] });
  expect(parsed?.hosts[0]?.resources).toEqual(resources);
  expect(hostFact(parsed!.hosts[0]!)).toContain("3 sandboxes running · up to 6");
  for (const broken of [
    { ...resources, capacity: -1 },
    { ...resources, mode: "surprise" },
    { ...resources, perSandbox: { ...resources.perSandbox, cpus: 99 } },
  ]) {
    expect(parseDockerHostList({ placement: true, hosts: [{ ...value, resources: broken }] })?.skipped).toBe(1);
  }
});

test("host limit permissions and daemon support survive parsing without granting them to older hosts", () => {
  const parse = (fields: Record<string, unknown>) =>
    parseDockerHostList({ placement: true, hosts: [{ ...host(), ...fields }] });
  expect(parse({ canManageLimits: true, limitsSupported: false })?.hosts[0]).toMatchObject({
    canManageLimits: true,
    limitsSupported: false,
  });
  expect(parse({})?.hosts[0]?.canManageLimits).toBeUndefined();
  expect(parse({})?.hosts[0]?.limitsSupported).toBeUndefined();
  for (const fields of [{ canManageLimits: "true" }, { limitsSupported: 1 }])
    expect(parse(fields)).toMatchObject({ hosts: [], skipped: 1 });
});

test("limit form serialization preserves blank overrides and resets all overrides only for automatic", () => {
  const data = new FormData();
  data.set("cpus", " 2.5 ");
  data.set("memory", "4g");
  data.set("maxSandboxes", "");
  expect(dockerHostLimitsInput(data)).toEqual({
    ok: true,
    patch: { cpus: 2.5, memoryBytes: 4 * 1024 ** 3 },
  });
  data.set("mode", "auto");
  expect(dockerHostLimitsInput(data)).toEqual({ ok: true, patch: { auto: true } });
  expect(dockerHostLimitsInput(new FormData())).toMatchObject({ ok: false });
  for (const [field, value] of [
    ["cpus", "NaN"],
    ["memory", "four gigs"],
    ["maxSandboxes", "1.5"],
  ]) {
    const invalid = new FormData();
    invalid.set(field, value);
    expect(dockerHostLimitsInput(invalid)).toMatchObject({ ok: false });
  }
});

test("busy-machine capacity including zero remains visible with held-back guidance", () => {
  const resources = {
    machine: { cpus: 16, memoryBytes: 38 * 1024 ** 3 },
    perSandbox: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 4096 },
    capacity: 7,
    heldBack: 2,
    mode: "automatic" as const,
  };
  const parsed = parseDockerHostList({ placement: true, hosts: [host({ resources, running: 5 })] });
  expect(hostFact(parsed!.hosts[0]!)).toContain("5 sandboxes running · up to 7 (2 held back: machine busy)");
  expect(
    parseDockerHostList({ placement: true, hosts: [host({ resources: { ...resources, capacity: 0 }, running: 0 })] })
      ?.skipped,
  ).toBe(0);
});

test("host action recovery distinguishes unavailable setup, ownership and uncertain changes", () => {
  expect(dockerHostActionFailure(404, "register")).toContain("check server setup");
  expect(dockerHostActionFailure(403, "limits")).toContain("host owner");
  expect(dockerHostActionFailure(403, "register")).toContain("organization admin");
  expect(dockerHostActionFailure(401, "revoke")).toContain("Sign in again");
  expect(dockerHostActionFailure(503, "register")).toContain("Unfinished setup");
  expect(dockerHostActionFailure(undefined, "limits")).toContain("could not be confirmed");
  expect(dockerHostActionFailure(409, "launch")).toContain("capacity and model account");
});

test("retention observations preserve explicit nulls and zero while malformed values exclude a host", () => {
  const fields = { retentionSeconds: 0, retentionOverrideSeconds: null, nextCleanupAt: "2026-11-14T12:00:00Z" };
  const parse = (fields: Record<string, unknown>) =>
    parseDockerHostList({ placement: true, hosts: [{ ...host(), ...fields }] });
  expect(parse(fields)?.hosts[0]).toMatchObject(fields);
  expect(parse({ retentionSeconds: null, nextCleanupAt: null })?.hosts[0]).toMatchObject({
    retentionSeconds: null,
    nextCleanupAt: null,
  });
  for (const fields of [
    { retentionSeconds: -1 },
    { retentionSeconds: 31536001 },
    { retentionOverrideSeconds: "24h" },
    { nextCleanupAt: "soon" },
  ])
    expect(parse(fields)).toMatchObject({ hosts: [], skipped: 1 });
});

test("Docker disk observations preserve missing, unknown and zero without accepting invalid bytes", () => {
  const parse = (fields: Record<string, unknown>) =>
    parseDockerHostList({ placement: true, hosts: [{ ...host(), ...fields }] });
  expect(parse({})?.hosts[0]?.diskFreeBytes).toBeUndefined();
  expect(parseDockerHostList({ placement: true, serverVersion: "2.49.6", hosts: [host()] })?.serverVersion).toBe(
    "2.49.6",
  );
  for (const value of [undefined, null, 0, 1e9])
    expect(parse({ stoppedSandboxBytes: value })?.hosts[0]?.stoppedSandboxBytes).toBe(value);
  for (const value of [-1, "100", 1.5])
    expect(parse({ stoppedSandboxBytes: value })).toMatchObject({ hosts: [], skipped: 1 });
  for (const value of [null, 0, 10_000_000_000])
    expect(parse({ diskFreeBytes: value })?.hosts[0]?.diskFreeBytes).toBe(value);
  for (const value of [-1, 0.5, "free", Number.MAX_SAFE_INTEGER + 1])
    expect(parse({ diskFreeBytes: value })).toMatchObject({ hosts: [], skipped: 1 });
});
