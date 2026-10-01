import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TOML } from "../../core/test/support.ts";
import { run } from "../src/cli.ts";
import type { Io } from "../src/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "armada-attach-"));
  dirs.push(dir);
  const requests: Record<string, unknown>[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: dir,
    env: {
      XDG_CONFIG_HOME: join(dir, "config"),
      ARMADA_API_KEY: "synthetic-key",
      ARMADA_API_URL: "https://armada.example.test",
    },
    readFile: async (path) => (path === join(dir, "armada.toml") ? DEMO_TOML : null),
    readBinaryFile: async () => Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ghToken: () => null,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    fetch: async (url, init) => {
      expect(String(url)).toBe("https://armada.example.test/api/cli/attachments");
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        attachment: { id: "synthetic-id" },
        url: "https://armada.example.test/agents/DEMO-7?tab=attachments&attachment=synthetic-id",
      });
    },
  };
  return { io, requests, out, err };
}

test("attach sends an image and HTTPS link with caption and free validation reference", async () => {
  const { io, requests, out } = await setup();
  expect(
    await run(
      [
        "attach",
        "DEMO-7",
        "overview.png",
        "https://example.test/design",
        "--caption",
        "New overview",
        "--for",
        "check-1",
      ],
      io,
    ),
  ).toBe(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    ticket: "DEMO-7",
    caption: "New overview",
    reference: "check-1",
    input: { kind: "image", contentType: "image/png", data: "iVBORw0KGgo=" },
  });
  expect(requests[1]).toMatchObject({ input: { kind: "link", url: "https://example.test/design" } });
  expect(out).toHaveLength(2);
  expect(out.join("")).not.toContain("synthetic-key");
});

test("CLI refuses type and size limits without uploading", async () => {
  const { io, requests, err } = await setup();
  expect(await run(["attach", "DEMO-7", "http://example.test"], io)).toBe(2);
  expect(err.join("")).toContain("HTTPS");
  io.readBinaryFile = async () => new Uint8Array(2 * 1024 * 1024 + 1);
  expect(await run(["attach", "DEMO-7", "huge.png"], io)).toBe(2);
  expect(err.join("")).toContain("2 MB");
  io.readBinaryFile = async () => new TextEncoder().encode("<svg />");
  expect(await run(["attach", "DEMO-7", "bad.svg"], io)).toBe(2);
  expect(err.join("")).toContain("type limit");
  expect(requests).toHaveLength(0);
});
