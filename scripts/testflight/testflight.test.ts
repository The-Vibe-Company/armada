import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const source = resolve(import.meta.dir, "testflight.sh");
const P8 = "-----BEGIN PRIVATE KEY-----\nfake-p8-body\n-----END PRIVATE KEY-----";
const P12 = "fake-p12-binary";
const IDENTITY = "0123456789ABCDEF0123456789ABCDEF01234567";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run the real script in a copy of the repository layout; fake only the Apple and Bun executables.
function run(command: string, buildNumber = "1042") {
  const dir = mkdtempSync(join(tmpdir(), "testflight-"));
  dirs.push(dir);
  {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "scripts/testflight"), { recursive: true });
    mkdirSync(join(repo, "apps/ios/Config"), { recursive: true });
    mkdirSync(join(repo, "apps/ios/TestFlight"), { recursive: true });
    copyFileSync(source, join(repo, "scripts/testflight/testflight.sh"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls");
    const executable = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\necho "${name} $*" >> "$CALLS"\n${body}\n`, {
        mode: 0o755,
      });
    executable(
      "security",
      `case "$1" in
  create-keychain) touch "\${@: -1}" ;;
  import) cp "$2" "$RUNNER_TEMP/imported.p12" ;;
  find-identity) printf '  1) ${IDENTITY} "iPhone Distribution: The Vibe Company (K28B69CWQ7)"\\n     1 valid identities found\\n' ;;
esac`,
    );
    executable(
      "bun",
      `if [[ "$2" == profile ]]; then echo profile > "$4"; echo profile-uuid; fi
if [[ "$2" == distribute ]]; then cp "$RUNNER_TEMP/testflight/private_keys/AuthKey_KEY123.p8" "$RUNNER_TEMP/p8-at-distribute"; fi`,
    );
    executable("xcodegen", 'cp Config/Signing.xcconfig "$RUNNER_TEMP/signing.xcconfig"');
    executable(
      "xcodebuild",
      `for arg in "$@"; do
  case "$arg" in -exportArchive) mkdir -p "$RUNNER_TEMP/testflight/export"; touch "$RUNNER_TEMP/testflight/export/Armada.ipa"
    cp "$RUNNER_TEMP/testflight/ExportOptions.plist" "$RUNNER_TEMP/export-options.plist" ;; esac
done`,
    );
    executable("plutil", 'if [[ "$2" == *CFBundleVersion ]]; then echo "$ARCHIVED_BUILD"; else echo 1.0.0; fi');
    executable("xcrun", "");
    const temp = join(dir, "temp");
    mkdirSync(temp);
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      CALLS: calls,
      HOME: join(dir, "home"),
      RUNNER_TEMP: temp,
      BUILD_NUMBER: buildNumber,
      ARCHIVED_BUILD: buildNumber,
      APP_STORE_CONNECT_API_KEY_ID: "KEY123",
      APP_STORE_CONNECT_API_ISSUER_ID: "issuer-uuid",
      APP_STORE_CONNECT_API_PRIVATE_KEY: P8,
      IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64: Buffer.from(P12).toString("base64"),
      IOS_DISTRIBUTION_CERTIFICATE_PASSWORD: "p12-password",
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    };
    const result = Bun.spawnSync(["bash", join(repo, "scripts/testflight/testflight.sh"), command], { env });
    const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      calls: read(calls).trim().split("\n").filter(Boolean),
      imported: read(join(temp, "imported.p12")),
      p8: read(join(temp, "p8-at-distribute")),
      signing: read(join(temp, "signing.xcconfig")),
      exportOptions: read(join(temp, "export-options.plist")),
      summary: read(join(dir, "summary")),
      // Simulate the always() cleanup step against the same runner state.
      cleanup: () => Bun.spawnSync(["bash", join(repo, "scripts/testflight/testflight.sh"), "cleanup"], { env }),
      paths: { temp, repo, home: join(dir, "home") },
      readCalls: () => read(calls),
    };
  }
}

test("signs with the distribution identity, uploads and distributes without exposing keys", () => {
  const result = run("publish");
  expect(result.exitCode, result.output).toBe(0);
  expect(result.imported).toBe(P12);
  expect(result.p8.trim()).toBe(P8);
  expect(result.signing).toBe("CODE_SIGN_STYLE = Manual\nPROVISIONING_PROFILE_SPECIFIER = profile-uuid\n");
  expect(result.exportOptions).toContain(`<key>signingCertificate</key><string>${IDENTITY}</string>`);
  expect(result.exportOptions).toContain("<key>co.thevibecompany.armada</key><string>profile-uuid</string>");
  expect(result.exportOptions).toContain("<key>method</key><string>app-store-connect</string>");
  const commands = result.calls.map((call) => {
    const [program, first, second] = call.split(" ");
    return program === "bun" ? `bun ${second}` : `${program} ${first}`;
  });
  expect(commands).toEqual([
    "security create-keychain",
    "security set-keychain-settings",
    "security unlock-keychain",
    "security import",
    "security set-key-partition-list",
    "security list-keychains",
    "security find-identity",
    "bun profile",
    "xcodegen generate",
    "xcodebuild -project",
    "plutil -extract",
    "plutil -extract",
    "xcodebuild -exportArchive",
    "xcrun altool",
    "bun distribute",
  ]);
  const archive = result.calls.find((call) => call.startsWith("xcodebuild -project")) ?? "";
  expect(archive).toContain("CURRENT_PROJECT_VERSION=1042");
  expect(archive).toContain(`CODE_SIGN_IDENTITY=${IDENTITY}`);
  expect(archive).toContain("-destination generic/platform=iOS");
  expect(result.calls.at(-2)).toContain(
    "--apple-id 6832706228 --bundle-id co.thevibecompany.armada --bundle-version 1042 --bundle-short-version-string 1.0.0",
  );
  expect(result.calls.at(-1)).toContain("distribute 6832706228 1.0.0 1042 Armada Internal");
  // Neither the private key nor the certificate ever reaches a command line or the log.
  for (const secret of ["fake-p8-body", Buffer.from(P12).toString("base64")]) {
    expect(result.calls.join("\n")).not.toContain(secret);
    expect(result.output).not.toContain(secret);
  }
  expect(result.summary).toContain("Armada 1.0.0 (1042) is on TestFlight");

  // The always() cleanup step removes everything publish left on the runner.
  const leftovers = [
    join(result.paths.temp, "testflight"),
    join(result.paths.repo, "apps/ios/Config/Signing.xcconfig"),
    join(result.paths.home, "Library/MobileDevice/Provisioning Profiles/profile-uuid.mobileprovision"),
    join(result.paths.home, "Library/Developer/Xcode/UserData/Provisioning Profiles/profile-uuid.mobileprovision"),
  ];
  expect(leftovers.map(existsSync)).toEqual([true, true, true, true]);
  expect(result.cleanup().exitCode).toBe(0);
  expect(leftovers.map(existsSync)).toEqual([false, false, false, false]);
  expect(result.readCalls()).toContain(
    `security delete-keychain ${join(result.paths.temp, "testflight/signing.keychain-db")}`,
  );
});

test("refuses a build number that could collide with the hand-uploaded builds", () => {
  const result = run("publish", "3");
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("BUILD_NUMBER must be an integer of at least 1000, got '3'.");
  expect(result.calls).toEqual([]);
});
