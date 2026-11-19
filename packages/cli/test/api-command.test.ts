import { expect, test } from "bun:test";
import { run } from "../src/run.ts";
import { memorySessionStore } from "../src/session.ts";

const accessToken = "saved-access";
const refreshToken = "saved-refresh";
const origin = "https://saved.armada.test";

async function invoke(
  args: string[],
  respond: (request: Request) => Response | Promise<Response>,
  readStdin?: () => Promise<string>,
  expiresAt = "2099-01-01T00:00:00.000Z",
) {
  let stdout = "";
  let stderr = "";
  const io = { out: (line: string) => (stdout += line), err: (line: string) => (stderr += line) };
  const unused = () => {
    throw new Error("Unexpected interactive I/O");
  };
  const code = await run(["api", ...args], io, {
    ...(readStdin ? { readStdin } : {}),
    auth: {
      ...io,
      env: {},
      now: unused,
      open: unused,
      session: memorySessionStore({ accessToken, refreshToken, expiresAt, armadaUrl: origin }),
      fetch: async (input, init) => respond(new Request(String(input), init)),
    },
  });
  return { code, stdout, stderr };
}

test.each([
  [[], "{}"],
  [['{"org":"example"}'], '{"org":"example"}'],
  [["-"], '{"org":"stdin"}'],
])("api POSTs authenticated JSON for %j and prints the response", async (args, body) => {
  const requests: Request[] = [];
  const output = await invoke(
    ["org/list", ...args],
    (request) => {
      requests.push(request);
      return Response.json({ organizations: [] });
    },
    async () => '{"org":"stdin"}',
  );
  expect(output).toEqual({ code: 0, stdout: '{"organizations":[]}\n', stderr: "" });
  expect(requests).toHaveLength(1);
  const [request] = requests;
  expect(request?.url).toBe(`${origin}/api/v1/org/list`);
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("content-type")).toBe("application/json");
  expect(request?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(await request?.text()).toBe(body);
});

test("api maps HTTP failures without echoing response text, codes or request secrets", async () => {
  const secret = "private-value";
  const output = await invoke(
    ["secrets/create", "-"],
    () => Response.json({ error: { code: "private_value", message: `${accessToken} ${secret}` } }, { status: 403 }),
    async () => JSON.stringify({ value: secret }),
  );
  expect(output.code).toBe(1);
  expect(output.stdout).toBe("");
  expect(output.stderr).toContain("Armada API request failed (HTTP 403).");
  for (const value of [accessToken, secret, "private_value"]) expect(output.stderr).not.toContain(value);
});

test("api hides input echoed by a failed login refresh", async () => {
  const requests: string[] = [];
  const output = await invoke(
    ["org/list"],
    (request) => {
      requests.push(new URL(request.url).pathname);
      return Response.json({ error: { code: "unavailable", message: refreshToken } }, { status: 503 });
    },
    undefined,
    "2000-01-01T00:00:00.000Z",
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEndWith("/refresh");
  expect(output.code).toBe(1);
  expect(output.stdout).toBe("");
  expect(output.stderr).toContain("Session renewal could not finish");
  expect(output.stderr).not.toContain(refreshToken);
});

test.each(["https://other.test/org/list", "/org/list", "%2e%2E/%2e%2e/auth/refresh"])(
  "api rejects route %s outside the versioned namespace",
  async (route) => {
    const output = await invoke([route], () => {
      throw new Error("Unexpected request");
    });
    expect(output.code).toBe(2);
    expect(output.stderr).toContain("Use a route relative to /api/v1/.");
  },
);

test("api rejects malformed JSON without echoing the input or making a request", async () => {
  const secret = "incomplete-private-json";
  const output = await invoke(["org/list", secret], () => {
    throw new Error("Unexpected request");
  });
  expect(output.code).toBe(2);
  expect(output.stderr).toContain("Request body must be valid JSON.");
  expect(output.stderr).not.toContain(secret);
});

test.each([
  ["<html>proxy</html>", 1, ""],
  ["null", 0, "null\n"],
  ['{"count":9007199254740993}', 0, '{"count":9007199254740993}\n'],
])("api distinguishes malformed success from a JSON response %s", async (body, code, stdout) => {
  const output = await invoke(["org/list"], () => new Response(body));
  expect(output.code).toBe(code);
  expect(output.stdout).toBe(stdout);
  if (code) expect(output.stderr).toContain("Armada API response was not valid JSON.");
  else expect(output.stderr).toBe("");
});

test("api accepts a no-content success without printing JSON", async () => {
  const output = await invoke(["org/list"], () => new Response(null, { status: 204 }));
  expect(output).toEqual({ code: 0, stdout: "", stderr: "" });
});
