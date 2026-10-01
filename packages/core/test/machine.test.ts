import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.ts";
import {
  ensurePersonalConfig,
  machinePaths,
  parsePersonalConfig,
  readCredentialStore,
  storeIsExposed,
  updateCredentialStore,
} from "../src/machine.ts";

const dirs: string[] = [];
const tempHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), "armada-machine-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("the store lives under an absolute XDG_CONFIG_HOME, else ~/.config, else nowhere", () => {
  expect(machinePaths({ XDG_CONFIG_HOME: "/x", HOME: "/h" })?.credentials).toBe("/x/armada/credentials");
  expect(machinePaths({ XDG_CONFIG_HOME: "relative", HOME: "/h" })?.config).toBe("/h/.config/armada/config.toml");
  expect(machinePaths({})).toBeNull();
});

test("the credentials file is created 0600 in a 0700 directory and updated without losing lines", async () => {
  const paths = machinePaths({ XDG_CONFIG_HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  expect(await readCredentialStore(paths.credentials)).toMatchObject({ exists: false, values: {} });

  await updateCredentialStore(paths, { LINEAR_API_KEY: "lin_api_first" });
  expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.credentials)).mode & 0o777).toBe(0o600);

  // A file someone wrote by hand, too open: the update keeps its content and closes it.
  await writeFile(paths.credentials, "# my keys\nLINEAR_API_KEY=lin_api_first\nOTHER_TOOL=keep\n");
  await chmod(paths.credentials, 0o644);
  const open = await readCredentialStore(paths.credentials);
  expect([open.mode, storeIsExposed(open)]).toEqual([0o644, true]);

  await updateCredentialStore(paths, { ARMADA_API_KEY: "armada_key_1" });
  expect(await readFile(paths.credentials, "utf8")).toBe(
    "# my keys\nLINEAR_API_KEY=lin_api_first\nOTHER_TOOL=keep\nARMADA_API_KEY=armada_key_1\n",
  );
  const after = await readCredentialStore(paths.credentials);
  expect([after.mode, storeIsExposed(after)]).toEqual([0o600, false]);
});

test("config.toml is created once from a commented template and parsed with the unknown-key rule", async () => {
  const paths = machinePaths({ HOME: await tempHome() });
  if (!paths) throw new Error("no paths");
  expect(await ensurePersonalConfig(paths)).toBe(true);
  expect(parsePersonalConfig(await readFile(paths.config, "utf8"))).toEqual({
    language: null,
    dashboard: { url: null },
    api: { url: null },
  });
  await writeFile(paths.config, 'language = "fr"\n');
  expect(await ensurePersonalConfig(paths)).toBe(false);
  expect(await readFile(paths.config, "utf8")).toBe('language = "fr"\n');

  expect(parsePersonalConfig('language = "fr"\n[api]\nurl = "https://armada.example.test"\n[later]\nx = 1\n')).toEqual({
    language: "fr",
    dashboard: { url: null },
    api: { url: "https://armada.example.test" },
  });
  const problems = (() => {
    try {
      parsePersonalConfig('stray = 1\n[api]\nurl = ""\ntoken = "no"\n');
    } catch (err) {
      if (err instanceof ConfigError) return err.problems;
    }
    return null;
  })();
  expect(problems).toEqual(['unknown key "stray"', 'unknown key "api.token"', '"api.url" must be a non-empty string']);
});
