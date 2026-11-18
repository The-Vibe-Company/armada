import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import legacyFiles from "./docs-guard-allowlist.json";

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

function* docsFiles(relative = "docs"): Generator<DocsFile> {
  const directory = join(import.meta.dir, "../..", relative);
  for (const name of readdirSync(directory)) {
    const path = `${relative}/${name}`;
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) yield* docsFiles(path);
    else yield { path, size: stat.size, read: stat.isFile() ? () => readFileSync(absolute) : undefined };
  }
}

if (import.meta.main) {
  const errors = checkDocsFiles(docsFiles(), new Map(Object.entries(legacyFiles)));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
