import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import packlist from "npm-packlist";
import { TARGETS } from "../build.ts";
import { NPM_PACKAGE, SDK_PACKAGE, stageNpm, stageSdk } from "../npm.ts";
import packFiles from "../release/npm-pack-files.json";
import bootstrappedPackages from "../release/npm-packages.json";
import { smokeSdk } from "../release/sdk-smoke.mjs";

export const NPM_PACK_FILES = packFiles;

type Manifest = Parameters<typeof packlist>[0]["package"] & {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
};

export function checkPackFiles(name: string, actual: readonly string[], expected: readonly string[]) {
  const missing = expected.filter((file) => !actual.includes(file)).sort();
  const extra = actual.filter((file) => !expected.includes(file)).sort();
  if (missing.length || extra.length) {
    throw new Error(
      `${name}: npm pack file mismatch (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
}

export function checkBootstrappedPackages(manifests: readonly Pick<Manifest, "name">[], approved: readonly string[]) {
  const names = new Set(manifests.map(({ name }) => name));
  const errors = [...names]
    .filter((name) => !approved.includes(name))
    .sort()
    .map((name) => `owner bootstrap required: ${name}`);
  const stale = approved.filter((name) => !names.has(name)).sort();
  if (stale.length) errors.push(`approved npm packages missing from staging: ${stale.join(", ")}`);
  if (errors.length) throw new Error(errors.join("\n"));
}

async function checkNpmPack() {
  const work = mkdtempSync(join(tmpdir(), "armada-npm-pack-"));
  try {
    const binaries = join(work, "binaries");
    mkdirSync(binaries);
    for (const target of TARGETS) writeFileSync(join(binaries, `armada-${target}`), "placeholder\n");
    const out = join(work, "npm");
    const staged = stageNpm({ binaries, out });
    const placeholderDeclarations = "export {};\n";
    const sdk = await stageSdk({ out, declarations: placeholderDeclarations });
    staged.push(sdk);

    const packages = await Promise.all(
      staged.map(async ({ name, dir }) => ({
        name,
        dir,
        manifest: (await Bun.file(join(dir, "package.json")).json()) as Manifest,
      })),
    );
    checkBootstrappedPackages(
      packages.map(({ manifest }) => manifest),
      bootstrappedPackages,
    );

    const installedSdk = join(work, "node_modules", SDK_PACKAGE);
    for (const { name, dir, manifest } of packages) {
      const bundled = manifest.bundleDependencies ?? manifest.bundledDependencies;
      if (bundled === true || (Array.isArray(bundled) && bundled.length)) {
        throw new Error(`${name}: unexpected bundled dependencies: ${JSON.stringify(bundled)}`);
      }
      const kind = name === SDK_PACKAGE ? "sdk" : name === NPM_PACKAGE ? "cli" : "platform";
      const files = await packlist({ path: dir, package: manifest, isProjectRoot: true });
      checkPackFiles(name, files, NPM_PACK_FILES[kind]);
      if (kind === "sdk") {
        const dependencies = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].flatMap(
          (field) => Object.keys(field ?? {}),
        );
        if (dependencies.length) {
          throw new Error(`${name}: unexpected runtime dependencies: ${dependencies.sort().join(", ")}`);
        }
        for (const file of files) {
          const destination = join(installedSdk, file);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(dir, file), destination);
        }
      }
    }

    const entry = Bun.resolveSync(SDK_PACKAGE, work);
    await smokeSdk(await import(entry));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await checkNpmPack();
  console.log("npm package manifests, file lists and SDK smoke passed.");
}
