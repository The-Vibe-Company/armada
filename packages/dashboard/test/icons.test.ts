import { describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { icons, pngInfo, sourceHash } from "../scripts/icons";

const ROOT = join(import.meta.dir, "..");

describe("the browser's icons (THE-881)", () => {
  test("are the ones `bun run icons` builds from the shell's mark today", async () => {
    for (const icon of icons()) {
      const committed = new Uint8Array(await readFile(join(ROOT, icon.file)));
      if (icon.px === undefined) {
        expect({ file: icon.file, svg: new TextDecoder().decode(committed) }).toEqual({
          file: icon.file,
          svg: icon.svg,
        });
        continue;
      }
      const { width, height, text } = pngInfo(committed);
      expect({ file: icon.file, width, height, source: text.source }).toEqual({
        file: icon.file,
        width: icon.px,
        height: icon.px,
        source: sourceHash(icon.svg),
      });
    }
  });

  test("pass the gate, which still holds every page and route", async () => {
    // proxy.ts reads the accounts on the server only; its matcher is all this test needs.
    mock.module("server-only", () => ({}));
    const { config } = await import("../proxy");
    const passes = (path: string) =>
      !unstable_doesMiddlewareMatch({ config, url: `https://fleet.example.test${path}` });
    const open = [
      "/icon.svg",
      "/icon.png",
      "/apple-icon.png",
      "/icon-192.png",
      "/icon-512.png",
      "/manifest.webmanifest",
    ];
    const gated = ["/", "/login", "/api/fleet", "/icon", "/icon.png.json", "/organization/icon.png"];
    expect(open.filter((p) => !passes(p))).toEqual([]);
    expect(gated.filter(passes)).toEqual([]);
  });
});
