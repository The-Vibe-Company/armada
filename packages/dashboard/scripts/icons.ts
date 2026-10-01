// The browser's icons of the dashboard (THE-881), built from the shell's mark
// (MARK in components/shell/Logo.tsx), never redrawn:
//   bun run icons      writes app/icon.svg, app/icon.png, app/apple-icon.png
//                      and public/icon-192.png, public/icon-512.png
// Run it after any change to the mark; test/icons.test.ts fails until then.
// Every icon is the mark on a tile of the dashboard's background, since its
// light triangles vanish on a light browser theme. Tab sizes (16 to 32 px) keep
// the three leading triangles only: the two dim outer ones blur at 16 px.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { MARK, markSvg } from "../components/shell/Logo";

/** The dashboard's background (`--bg` in app/globals.css), also the browser's theme colour. */
export const ICON_BACKGROUND = "#09090b";

/** Shapes the tab icon keeps: the leader and its two wings. */
const SMALL_MARK = 3;

export type Icon = { file: string; svg: string; px?: number };

/** The bounds of the leading `count` shapes of the mark (absolute M, L, H, V and Z commands only). */
function markBounds(count: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { d } of MARK.slice(0, count)) {
    let x = 0;
    let y = 0;
    for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
      const n = (args ?? "")
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (cmd === "M" || cmd === "L") [x, y] = n as [number, number];
      else if (cmd === "H") x = n[0] as number;
      else if (cmd === "V") y = n[0] as number;
      else continue;
      xs.push(x);
      ys.push(y);
    }
  }
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/** The leading `count` shapes of the mark, fitted on a 32 × 32 tile with `pad` around them. */
function tile(count: number, opts: { pad: number; radius: number }): string {
  const b = markBounds(count);
  const box = 32 - 2 * opts.pad;
  const scale = Math.min(box / b.width, box / b.height);
  const round = (n: number) => Number(n.toFixed(3));
  const x = round(16 - (b.x + b.width / 2) * scale);
  const y = round(16 - (b.y + b.height / 2) * scale);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>Armada</title>`,
    `<rect width="32" height="32" rx="${opts.radius}" fill="${ICON_BACKGROUND}"/>`,
    `<g transform="translate(${x} ${y}) scale(${round(scale)})">${markSvg(count)}</g></svg>\n`,
  ].join("");
}

/** Every icon the script writes, relative to the dashboard; `px` for the rendered ones. */
export function icons(): Icon[] {
  const small = tile(SMALL_MARK, { pad: 4, radius: 7 });
  const full = tile(MARK.length, { pad: 3, radius: 7 });
  // iOS rounds the home-screen icon itself and fills transparent corners with black.
  const square = tile(MARK.length, { pad: 3, radius: 0 });
  return [
    { file: "app/icon.svg", svg: small },
    { file: "app/icon.png", svg: small, px: 32 },
    { file: "app/apple-icon.png", svg: square, px: 180 },
    { file: "public/icon-192.png", svg: full, px: 192 },
    { file: "public/icon-512.png", svg: full, px: 512 },
  ];
}

/** The hash a rendered icon carries, of the SVG it was rendered from. */
export const sourceHash = (svg: string) => createHash("sha256").update(svg).digest("hex");

/** The PNG's text chunks (keyword → text) and its width and height. */
export function pngInfo(png: Uint8Array): { width: number; height: number; text: Record<string, string> } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const text: Record<string, string> = {};
  for (let at = 8; at + 8 <= png.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      text[new TextDecoder("latin1").decode(data.subarray(0, nul))] = new TextDecoder("latin1").decode(
        data.subarray(nul + 1),
      );
    }
    at += 12 + length;
  }
  return { width: view.getUint32(16), height: view.getUint32(20), text };
}

/** `png` with a tEXt chunk `source` = the hash of `svg`, right after its header. */
function withSource(png: Uint8Array, svg: string): Uint8Array {
  const data = new TextEncoder().encode(`source\0${sourceHash(svg)}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const headerEnd = 8 + 25; // signature, then IHDR (13 bytes of data)
  return Buffer.concat([png.subarray(0, headerEnd), chunk, png.subarray(headerEnd)]);
}

async function main() {
  // Only this script renders: the dashboard's build never loads resvg.
  const { Resvg } = await import("@resvg/resvg-js");
  const root = join(import.meta.dir, "..");
  for (const icon of icons()) {
    const body =
      icon.px === undefined
        ? icon.svg
        : withSource(new Resvg(icon.svg, { fitTo: { mode: "width", value: icon.px } }).render().asPng(), icon.svg);
    await writeFile(join(root, icon.file), body);
    console.log(`wrote ${icon.file}`);
  }
}

if (import.meta.main) await main();
