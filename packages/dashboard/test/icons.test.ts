import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
    // Neither proxy.ts nor Next's matcher helper is imported: each loads server modules for every later
    // test file of the run. The matcher is one literal pattern, which Next anchors at both ends.
    const source = await readFile(join(ROOT, "proxy.ts"), "utf8");
    const matcher = JSON.parse(/matcher: \[\s*("(?:[^"\\]|\\.)*")/.exec(source)?.[1] ?? "null") as string;
    const passes = (path: string) => !new RegExp(`^${matcher}$`).test(path);
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
