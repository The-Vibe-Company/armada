import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import legacyFiles from "./docs-guard-allowlist.json";

const root = join(import.meta.dir, "../..");
const allowlistPath = "scripts/ci/docs-guard-allowlist.json";
const maxBytes = 200_000;
const mediaExtension = /\.(?:apng|avif|bmp|gif|heic|heif|ico|jpe?g|mkv|mov|mp4|png|svgz?|tiff?|webm|webp)$/i;

type DocsFile = {
  path: string;
  size: number;
  read: (() => Buffer) | undefined;
};

export function checkDocsFiles(files: Iterable<DocsFile>, allowlist: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  const unused = new Set(allowlist.keys());
  for (const { path, size, read } of files) {
    if (!read) {
      errors.push(`${path}: expected a regular file`);
      continue;
    }

    const expectedHash = allowlist.get(path);
    const content = size <= maxBytes || expectedHash ? read() : undefined;
    let reason: string;
    if (size > maxBytes) reason = `${size} bytes exceeds ${maxBytes} bytes`;
    else if (mediaExtension.test(path)) reason = "images and videos are forbidden";
    else if (content && (!isUtf8(content) || content.includes(0))) reason = "expected UTF-8 text";
    else continue;

    unused.delete(path);
    if (expectedHash && content && createHash("sha256").update(content).digest("hex") === expectedHash) {
      continue;
    }
    errors.push(`${path}: ${reason}`);
  }

  for (const path of unused) errors.push(`${path}: remove the unused docs allowlist entry`);
  return errors.sort();
}

export function checkDocsAllowlist(
  current: ReadonlyMap<string, string>,
  baseline: ReadonlyMap<string, string>,
): string[] {
  return [...current]
    .filter(([path, hash]) => baseline.get(path) !== hash)
    .map(([path]) => `${path}: docs allowlist entries can only be removed`)
    .sort();
}

function baseAllowlist(ref: string): Map<string, string> | undefined {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  // The first commit installing the guard has no allowlist on its base.
  if (!git("ls-tree", ref, "--", allowlistPath)) return undefined;
  return new Map(Object.entries(JSON.parse(git("show", `${ref}:${allowlistPath}`)) as Record<string, string>));
}

function* docsFiles(relative = "docs"): Generator<DocsFile> {
  const directory = join(root, relative);
  for (const name of readdirSync(directory)) {
    const path = `${relative}/${name}`;
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) yield* docsFiles(path);
    else yield { path, size: stat.size, read: stat.isFile() ? () => readFileSync(absolute) : undefined };
  }
}

if (import.meta.main) {
  const allowlist = new Map(Object.entries(legacyFiles));
  const base = process.argv[2];
  const baseline = base ? baseAllowlist(base) : undefined;
  const errors = base ? checkDocsAllowlist(allowlist, baseline ?? allowlist) : checkDocsFiles(docsFiles(), allowlist);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
