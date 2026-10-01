import { describe, expect, test } from "bun:test";
import { checkPublished, MINIMUM_CLI_VERSION, NPM_REGISTRY_URL } from "@armada/core/read";
import { handleCli } from "../lib/cli-api.ts";
import { PUBLISHED_CLI_CACHE_MS, publishedCli } from "../lib/cli-version.ts";

const BUILD = "0.2.8";
const PREVIOUS = "0.2.7";
const tarball = (version: string) => `https://registry.npmjs.org/@the-vibe-company/armada/-/armada-${version}.tgz`;

function registry() {
  let now = 0;
  let ready = false;
  let offline = false;
  let calls = 0;
  const fetch = async (url: string) => {
    calls++;
    if (offline) throw new TypeError("fetch failed");
    if (url === NPM_REGISTRY_URL)
      return Response.json({
        "dist-tags": { latest: BUILD },
        versions: Object.fromEntries(
          [BUILD, PREVIOUS].map((version) => [version, { dist: { tarball: tarball(version) } }]),
        ),
      });
    return new Response(null, { status: url === tarball(BUILD) && !ready ? 404 : 200 });
  };
  return {
    fetch,
    cache: publishedCli(BUILD, fetch, () => now),
    advance: (milliseconds = PUBLISHED_CLI_CACHE_MS) => {
      now += milliseconds;
    },
    publish: () => {
      ready = true;
    },
    disconnect: () => {
      offline = true;
    },
    calls: () => calls,
  };
}

describe("the published CLI version", () => {
  test("stays quiet cold, caches tarball checks for five minutes, then agrees with the brief", async () => {
    const npm = registry();
    expect(npm.cache.current()).toBe(MINIMUM_CLI_VERSION);
    await npm.cache.refresh();
    expect(npm.cache.current()).toBe(PREVIOUS);
    expect(npm.calls()).toBe(3);
    expect(await checkPublished(BUILD, npm.fetch)).toEqual({ state: "missing", newest: npm.cache.current() });
    const calls = npm.calls();
    npm.publish();
    await npm.cache.refresh();
    expect(npm.cache.current()).toBe(PREVIOUS);
    expect(npm.calls()).toBe(calls);
    npm.advance(PUBLISHED_CLI_CACHE_MS - 1);
    expect(npm.cache.stale()).toBe(false);
    await npm.cache.refresh();
    expect(npm.calls()).toBe(calls);
    npm.advance(1);
    expect(npm.cache.stale()).toBe(true);
    await npm.cache.refresh();
    expect(npm.cache.current()).toBe(BUILD);
    expect(await checkPublished(BUILD, npm.fetch)).toEqual({ state: "published" });
  });

  test("an outage stays quiet cold and retains the verified version when warm, with failure caching", async () => {
    const cold = registry();
    cold.disconnect();
    await cold.cache.refresh();
    expect(cold.cache.current()).toBe(MINIMUM_CLI_VERSION);
    const warm = registry();
    await warm.cache.refresh();
    warm.disconnect();
    warm.advance();
    await warm.cache.refresh();
    expect(warm.cache.current()).toBe(PREVIOUS);
    const calls = warm.calls();
    await warm.cache.refresh();
    expect(warm.calls()).toBe(calls);
  });

  test("a hanging refresh never delays a CLI response and concurrent refreshes share one request", async () => {
    let finish!: (response: Response) => void;
    let calls = 0;
    const cache = publishedCli(BUILD, () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const work: (() => Promise<void>)[] = [];
    const response = await handleCli(new Request("http://localhost/api/cli/session"), ["session"], {
      accounts: async () => null,
      publishedCli: cache,
      after: (task) => {
        work.push(task);
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("x-armada-cli-latest")).toBe(MINIMUM_CLI_VERSION);
    expect(calls).toBe(0);
    const first = work[0]?.();
    const second = cache.refresh();
    expect(calls).toBe(1);
    const whileRefreshing = await handleCli(new Request("http://localhost/api/cli/session"), ["session"], {
      accounts: async () => null,
      publishedCli: cache,
      after: (task) => {
        work.push(task);
      },
    });
    expect(whileRefreshing.status).toBe(503);
    expect(whileRefreshing.headers.get("x-armada-cli-latest")).toBe(MINIMUM_CLI_VERSION);
    const third = work[1]?.();
    expect(calls).toBe(1);
    finish(Response.json({ versions: { "99.0.0": {} } }));
    await Promise.all([first, second, third]);
    expect(cache.current()).toBe(MINIMUM_CLI_VERSION);
  });

  test("refusals and upgrade instructions use the same verified header", async () => {
    const npm = registry();
    await npm.cache.refresh();
    const response = await handleCli(
      new Request("http://localhost/api/cli/session", {
        headers: { "x-armada-cli-version": "0.0.1" },
      }),
      ["session"],
      { accounts: async () => null, publishedCli: npm.cache },
    );
    expect(response.status).toBe(426);
    expect(response.headers.get("x-armada-cli-latest")).toBe(PREVIOUS);
    expect(await response.json()).toMatchObject({ next: `npm install -g @the-vibe-company/armada@${PREVIOUS}` });
  });
});
