import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthIo } from "../src/auth-commands.ts";
import { filePreferences } from "../src/preferences.ts";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const selectedOrg = "11111111-1111-4111-8111-111111111111";
const overrideOrg = "22222222-2222-4222-8222-222222222222";

test("URL/JSON MCP creation use canonical authenticated HTTP bodies and persisted org selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-parity-shortcuts-"));
  try {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let output = "";
    let error = "";
    const preferencesPath = join(directory, "preferences.json");
    const auth: AuthIo = {
      env: { ARMADA_URL: "https://armada.test", ARMADA_TOKEN: "fixture-bearer" },
      session: memorySessionStore(),
      preferences: filePreferences(preferencesPath),
      now: () => new Date(),
      open: () => undefined,
      out: (text) => {
        output += text;
      },
      err: (text) => {
        error += text;
      },
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer fixture-bearer");
        expect(request.headers.get("content-type")).toBe("application/json");
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({ path, body });
        if (path === "/api/v1/org/list")
          return Response.json({ orgs: [{ id: selectedOrg, name: "Team", role: "admin" }] });
        if (path === "/api/v1/mcp/create" || path === "/api/v1/mcp/update")
          return Response.json({
            connection: {
              id: "connection",
              name: body.name,
              orgId: body.org,
              scope: body.scope ?? "personal",
              status: "not_connected",
            },
          });
        throw new Error("Unexpected Armada HTTP endpoint.");
      },
    };
    async function execute(args: string[], input: { stdin?: string; file?: string } = {}) {
      output = "";
      error = "";
      const code = await run(
        args,
        { out: auth.out, err: auth.err },
        {
          auth,
          readStdin: async () => input.stdin ?? "",
          readFile: async () => {
            if (input.file === undefined) throw new Error("No file fixture.");
            return input.file;
          },
        },
      );
      return { code, out: output, err: error };
    }
    expect((await execute(["org", "use", "Team"])).code).toBe(0);
    auth.preferences = filePreferences(preferencesPath);
    const shortcut = await execute(["mcp", "add", "Public service", "https://mcp.example.com/mcp", "--json"]);
    expect(shortcut.code).toBe(0);
    expect(requests.at(-1)).toEqual({
      path: "/api/v1/mcp/create",
      body: {
        org: selectedOrg,
        name: "Public service",
        url: "https://mcp.example.com/mcp",
        scope: "personal",
        transport: "http",
        authType: "auto",
      },
    });
    expect(JSON.parse(shortcut.out).connection.status).toBe("not_connected");
    expect(
      (
        await execute([
          "mcp",
          "add",
          "Shared service",
          "https://oauth.example.com/mcp",
          "--scope",
          "org",
          "--org",
          overrideOrg,
        ])
      ).code,
    ).toBe(0);
    expect(requests.at(-1)?.body).toEqual({
      org: overrideOrg,
      name: "Shared service",
      url: "https://oauth.example.com/mcp",
      scope: "org",
      transport: "http",
      authType: "auto",
    });
    const definition = {
      name: "Pinned stdio",
      scope: "personal",
      transport: "stdio",
      command: "node",
      args: ["/opt/pinned/server.js"],
      authType: "headers",
      headers: { Authorization: "fixture-write-only-header" },
    };
    for (const file of [false, true]) {
      const full = await execute(
        ["mcp", "add", ...(file ? ["--file", "definition.json"] : []), "--json"],
        file ? { file: JSON.stringify(definition) } : { stdin: JSON.stringify(definition) },
      );
      expect(full.code).toBe(0);
      expect(requests.at(-1)?.body).toEqual({ ...definition, org: selectedOrg });
      expect(full.out).not.toContain("fixture-write-only-header");
    }
    const update = await execute(["mcp", "update", "connection", "--file", "definition.json"], {
      file: JSON.stringify(definition),
    });
    expect(update.code).toBe(0);
    expect(requests.at(-1)).toEqual({
      path: "/api/v1/mcp/update",
      body: { ...definition, id: "connection", org: selectedOrg },
    });
    const beforeInvalid = requests.length;
    for (const args of [
      ["creds", "list", "--scope", "org"],
      ["mcp", "add", "Name", "https://mcp.example.com", "--file", "definition.json"],
      ["mcp", "add", "Name", "https://user:private@host.example/mcp"],
      ["mcp", "add", "Name", "https://host.example/mcp?access_token=private"],
      ["mcp", "add", "Name", "https://mcp.example.com", "--scope", "invalid"],
      ["mcp", "update", "connection", "--scope", "org", "--file", "definition.json"],
    ]) {
      const rejected = await execute(args, { file: JSON.stringify(definition) });
      expect(rejected.code).toBe(2);
      expect(rejected.out).toBe("");
      expect(rejected.err).not.toContain("private");
    }
    expect(
      (await execute(["mcp", "add", "Name", "https://mcp.example.com"], { stdin: JSON.stringify(definition) })).code,
    ).toBe(2);
    expect(requests).toHaveLength(beforeInvalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
