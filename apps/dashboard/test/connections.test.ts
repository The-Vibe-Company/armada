import { describe, expect, test } from "bun:test";
import {
  checkHeaders,
  checkOAuthRegistration,
  checkServerUrl,
  checkStdio,
  completeUpdate,
  connectAction,
  launchDefaults,
  launchSelection,
  type McpConnection,
  oauthCallbackInput,
  oauthReturn,
  parseStdioImport,
  statusLabel,
  unreadyDefaults,
} from "../src/lib/connections.ts";

const ORG = "00000000-0000-4000-8000-000000000010";
const connection = (n: number, overrides: Partial<McpConnection> = {}): McpConnection => ({
  id: `00000000-0000-4000-8000-0000000000${n}`,
  name: `server-${n}`,
  orgId: ORG,
  scope: "org",
  transport: "http",
  authType: "none",
  status: "connected",
  defaultForLaunch: false,
  ...overrides,
});

describe("launch selection", () => {
  const personal = connection(50, { scope: "personal", name: "My Linear" });
  const shared = connection(51);
  const expired = connection(52, { status: "needs_reconnect" });
  const available = [personal, shared, expired];

  test.each([
    ["a personal connection in a private sandbox from a shared golden", "private", "org", [personal.id], true],
    ["org connections in an org sandbox", "org", "org", [shared.id, shared.id], true],
    ["a personal connection in an org sandbox", "org", "org", [personal.id], "needs a private sandbox"],
    ["an org sandbox from a private golden", "org", "private", [], "stays private"],
    ["a connection that needs reconnecting", "private", "org", [expired.id], "Needs reconnect"],
    ["an id not listed for the org", "private", "org", ["00000000-0000-4000-8000-000000000099"], "no longer available"],
    ["a missing visibility", "", "org", [], "who can see"],
  ] as const)("%s", (_name, visibility, goldenVisibility, connections, expected) => {
    const result = launchSelection({ visibility, goldenVisibility, connections: [...connections], available });
    if (expected === true) {
      expect(result).toEqual({ ok: true, value: { visibility, connections: [...new Set(connections)] } });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(expected);
    }
  });
});

describe("launch defaults", () => {
  const personal = connection(53, { scope: "personal", defaultForLaunch: true });
  const shared = connection(54, { defaultForLaunch: true });
  const optIn = connection(55);
  const expired = connection(56, { defaultForLaunch: true, status: "needs_reconnect" });
  const disabled = connection(57, { defaultForLaunch: true, status: "disabled" });
  const available = [personal, shared, optIn, expired, disabled];

  test.each([
    ["a private sandbox starts with every usable default", "private", [personal.id, shared.id]],
    ["an org sandbox never gets a personal default", "org", [shared.id]],
  ] as const)("%s", (_name, visibility, expected) => {
    expect(launchDefaults(available, visibility)).toEqual([...expected]);
  });

  test("a default that is enabled but not connected is reported, never silently dropped", () => {
    const personalExpired = connection(59, { scope: "personal", defaultForLaunch: true, status: "unavailable" });
    const all = [...available, personalExpired];
    expect(unreadyDefaults(all, "private").map((item) => item.id)).toEqual([expired.id, personalExpired.id]);
    // An org sandbox never takes a personal default, so a broken one does not concern it.
    expect(unreadyDefaults(all, "org").map((item) => item.id)).toEqual([expired.id]);
  });
});

test.each([
  [{ status: "not_connected" }, "Connect"],
  [{ status: "needs_reconnect" }, "Reconnect"],
  [{ status: "unavailable" }, "Retry"],
  [{ status: "connected" }, null],
  [{ status: "disabled" }, null],
  [{ status: "not_connected", transport: "stdio" }, "Configure"],
] as const)("a connection %j offers %p", (state, expected) => {
  expect(connectAction(connection(58, { authType: "oauth", ...state }))).toBe(expected);
});

describe("stdio definitions", () => {
  test.each([
    ["npx", "-y\n@modelcontextprotocol/server-filesystem@2026.1.14\n/workspace", true],
    ["npx", "--package=@scope/server@1.2.3-beta.1\nserver", true],
    ["uvx", "mcp-server-git==2026.1.14", true],
    ["uvx", "--from\nmcp-server-git==1.0.0\nmcp-server-git", true],
    ["/usr/local/bin/my-server", "--stdio", true],
    ["npx", "-y\n@modelcontextprotocol/server-filesystem", "exact version"],
    ["npx", "-y\nserver@latest", "exact version"],
    ["bunx", "server@^1.2.0", "exact version"],
    ["uvx", "mcp-server-git", "exact version"],
    ["npx -y server@1.0.0", "", "one program"],
    ["npx;rm", "", "one program"],
  ])("%s %j", (command, args, expected) => {
    const result = checkStdio(command, args);
    if (expected === true) expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, error: expect.stringContaining(expected) });
  });

  test("an import fills one server's command and arguments and refuses env, remotes and several servers", () => {
    expect(
      parseStdioImport(JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "fs@1.0.0"] } } })),
    ).toEqual({ ok: true, value: { name: "files", command: "npx", args: ["-y", "fs@1.0.0"] } });
    expect(parseStdioImport(JSON.stringify({ command: "uvx", args: ["git==1.0"] }))).toMatchObject({ ok: true });
    const refusals: [unknown, string][] = [
      [{ mcpServers: { a: { command: "npx", env: { TOKEN: "x" } } } }, "env"],
      [{ mcpServers: { a: { url: "https://x" } } }, "by URL"],
      [{ mcpServers: { a: { command: "x" }, b: { command: "y" } } }, "one server at a time"],
    ];
    for (const [input, expected] of refusals) {
      expect(parseStdioImport(JSON.stringify(input))).toEqual({ ok: false, error: expect.stringContaining(expected) });
    }
    expect(parseStdioImport("not json")).toMatchObject({ ok: false });
  });
});

describe("remote form fields", () => {
  test.each([
    [" https://mcp.example.com/mcp ", true],
    ["https://mcp.supabase.com/mcp?project_ref=abcd&read_only=true", true],
    ["https://mcp.example.com/mcp?monkey=1&keyboard=us", true],
    ["http://localhost:3000/mcp", true],
    ["http://mcp.example.com/mcp", "https://"],
    ["https://user:secret@mcp.example.com/mcp", "user name or password"],
    ["https://mcp.example.com/mcp#token=abc", "#fragment"],
    ["https://mcp.example.com/mcp?api_key=abc", "api_key"],
    ["https://mcp.example.com/mcp?access_token=abc", "access_token"],
    ["https://mcp.example.com/mcp?x-api-key=abc", "x-api-key"],
    ["https://mcp.example.com/mcp?Token=abc", "Token"],
  ])("server URL %s", (url, expected) => {
    const result = checkServerUrl(url);
    if (expected === true) expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, error: expect.stringContaining(expected) });
  });

  test("headers skip blank rows and refuse reserved, repeated or empty entries", () => {
    expect(checkHeaders(["X-Api-Key", "", "x-team"], ["k1", "", "core"])).toEqual({
      ok: true,
      value: { "X-Api-Key": "k1", "x-team": "core" },
    });
    expect(checkHeaders(["Host"], ["evil"]).ok).toBe(false);
    expect(checkHeaders(["X-A", "x-a"], ["1", "2"]).ok).toBe(false);
    expect(checkHeaders(["X-A"], [""]).ok).toBe(false);
    expect(checkHeaders(["X-A"], ["a\r\nInjected: 1"]).ok).toBe(false);
    expect(checkHeaders([""], [""]).ok).toBe(false);
  });
});

test("an OAuth return only yields a connection id and a fixed outcome", () => {
  const id = "00000000-0000-4000-8000-000000000050";
  expect(oauthReturn({ connection: id, oauth: "connected" })).toEqual({ id, outcome: "returned" });
  expect(oauthReturn({ oauth: "failed" })).toEqual({ id: null, outcome: "failed" });
  expect(oauthReturn({ connection: "../x", oauth: "denied" })).toEqual({ id: null, outcome: "denied" });
  expect(oauthReturn({ connection: "../x", oauth: "connected" })).toBeNull();
  expect(oauthReturn({})).toBeNull();
});

test.each([
  ["state=abcdefgh1234&code=c0de-x&iss=https%3A%2F%2Fauth.example", "complete"],
  ["state=abcdefgh1234&code=c0de-x", "complete"],
  ["error=access_denied&error_description=no&state=abcdefgh1234", "denied"],
  ["error=server_error&state=abcdefgh1234&code=c0de-x", "invalid"],
  ["state=short&code=c0de", "invalid"],
  ["state=abcdefgh1234", "invalid"],
  ["state=abcdefgh1234&code=has%20space", "invalid"],
  ["state=abcdefgh1234&code=c&iss=javascript%3Aalert(1)", "invalid"],
  ["state=abcdefgh1234&code=c&iss=https%3A%2F%2Fauth.example%3Fx%3D1", "invalid"],
])("the callback %s is %s", (query, kind) => {
  const input = oauthCallbackInput(new URLSearchParams(query));
  expect(input.kind).toBe(kind as never);
  if (input.kind === "complete") expect(input).not.toHaveProperty("error");
});

test("an OAuth preregistration is optional and becomes the opaque authentication JSON", () => {
  expect(checkOAuthRegistration(" ", "")).toEqual({ ok: true, value: undefined });
  expect(checkOAuthRegistration("client-1", "")).toEqual({ ok: true, value: '{"client_id":"client-1"}' });
  expect(checkOAuthRegistration("client-1", "s3")).toEqual({
    ok: true,
    value: '{"client_id":"client-1","client_secret":"s3"}',
  });
  expect(checkOAuthRegistration("", "s3").ok).toBe(false);
});

describe("full-replace edit", () => {
  const remote = connection(70, { scope: "personal", url: "https://mcp.example/mcp", authType: "bearer" });
  const local = connection(71, { transport: "stdio", command: "npx", args: ["-y", "fs@1.0.0"] });

  test("restates the stored scope and sends the whole definition", () => {
    const edited = { transport: "sse" as const, url: "https://mcp.example/sse", args: [], authType: "auto" as const };
    expect(completeUpdate(remote, "Renamed", edited)).toEqual({
      ok: true,
      value: { id: remote.id, scope: "personal", name: "Renamed", ...edited },
    });
    expect(
      completeUpdate(local, "files", { transport: "stdio", command: "uvx", args: ["git==1.0"], authType: "none" }),
    ).toMatchObject({ ok: true, value: { scope: "org", command: "uvx", args: ["git==1.0"] } });
  });

  test("refuses turning a remote connection into a stdio one, or back", () => {
    expect(completeUpdate(remote, "x", { transport: "stdio", command: "npx", args: [], authType: "none" }).ok).toBe(
      false,
    );
    expect(
      completeUpdate(local, "x", { transport: "http", url: "https://a.example", args: [], authType: "none" }).ok,
    ).toBe(false);
  });
});

test("a stdio connection reads as configured for launch, never as a live connection", () => {
  expect(statusLabel({ transport: "stdio", status: "connected" })).toBe("Configured for launch");
  expect(statusLabel({ transport: "stdio", status: "not_connected" })).toBe("Not configured");
  expect(statusLabel({ transport: "http", status: "connected" })).toBe("Connected");
});
