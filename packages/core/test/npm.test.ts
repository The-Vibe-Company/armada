import { describe, expect, test } from "bun:test";
import type { Fetch } from "../src/linear.ts";
import { checkPublished, NPM_REGISTRY_URL } from "../src/npm.ts";

const tarball = (version: string) => `https://registry.npmjs.org/@the-vibe-company/armada/-/armada-${version}.tgz`;
const metadata = (...versions: string[]) => ({
  "dist-tags": { latest: versions[0] },
  versions: Object.fromEntries(versions.map((version) => [version, { dist: { tarball: tarball(version) } }])),
});

describe("npm availability", () => {
  test("uses abbreviated metadata and verifies the newest stable tarball no higher than the build", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: Fetch = async (url, init) => {
      calls.push({ url, init });
      return url === NPM_REGISTRY_URL
        ? Response.json(metadata("0.3.0", "0.2.8-rc.1", "0.2.7", "0.2.6"))
        : new Response(null, { status: 200 });
    };
    expect(await checkPublished("0.2.8", fetch)).toEqual({ state: "missing", newest: "0.2.7" });
    expect(calls.map(({ url }) => url)).toEqual([NPM_REGISTRY_URL, tarball("0.2.7")]);
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("application/vnd.npm.install-v1+json");
    expect(calls[1]?.init.method).toBe("HEAD");
    expect(calls[1]?.init.signal).toBe(calls[0]?.init.signal);
  });

  test("a moved latest tag is not published until its tarball answers 200", async () => {
    let ready = false;
    const fetch: Fetch = async (url) =>
      url === NPM_REGISTRY_URL
        ? Response.json(metadata("0.2.8", "0.2.7"))
        : new Response(null, { status: url === tarball("0.2.8") && !ready ? 404 : 200 });
    expect(await checkPublished("0.2.8", fetch)).toEqual({ state: "missing", newest: "0.2.7" });
    ready = true;
    expect(await checkPublished("0.2.8", fetch)).toEqual({ state: "published" });
  });

  test("skips missing tarball URLs and multiple unavailable tarballs", async () => {
    const fetch: Fetch = async (url) =>
      url === NPM_REGISTRY_URL
        ? Response.json({
            ...metadata("0.2.8", "0.2.7", "0.2.6"),
            versions: {
              ...metadata("0.2.8", "0.2.7", "0.2.6").versions,
              "0.2.9": {},
            },
          })
        : new Response(null, { status: url === tarball("0.2.6") ? 200 : 404 });
    expect(await checkPublished("0.2.9", fetch)).toEqual({ state: "missing", newest: "0.2.6" });
  });

  test("none is available when all candidates are missing or newer", async () => {
    expect(await checkPublished("0.2.8", async () => Response.json(metadata("0.3.0")))).toEqual({
      state: "missing",
      newest: null,
    });
    expect(
      await checkPublished("0.2.8", async (url) =>
        url === NPM_REGISTRY_URL ? Response.json(metadata("0.2.8")) : new Response(null, { status: 404 }),
      ),
    ).toEqual({ state: "missing", newest: null });
  });

  test("registry and tarball outages are unknown, never published", async () => {
    expect(
      await checkPublished("0.2.8", async () => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({
      state: "unknown",
      reason: "fetch failed",
    });
    for (const status of [204, 403, 500, 503]) {
      expect(
        await checkPublished("0.2.8", async (url) =>
          url === NPM_REGISTRY_URL ? Response.json(metadata("0.2.8")) : new Response(null, { status }),
        ),
      ).toEqual({ state: "unknown", reason: `npm tarball answered HTTP ${status}` });
    }
    for (const body of [null, {}, { versions: [] }, { versions: {} }]) {
      expect((await checkPublished("0.2.8", async () => Response.json(body))).state).toBe("unknown");
    }
  });

  test("a tarball abort shares the metadata timeout budget and never throws", async () => {
    expect(
      await checkPublished(
        "0.2.8",
        async (url) => {
          if (url === NPM_REGISTRY_URL) return Response.json(metadata("0.2.8"));
          throw new DOMException("timed out", "TimeoutError");
        },
        500,
      ),
    ).toEqual({ state: "unknown", reason: "no answer within 500 ms" });
  });
});
