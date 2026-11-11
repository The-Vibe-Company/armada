import { describe, expect, test } from "bun:test";
import { createSkillCatalog } from "../src/skill-catalog.ts";
import { VaultError, type VaultErrorCode } from "../src/vault-error.ts";

const publicSkill = {
  org_slug: "team",
  skill_slug: "testing",
  name: "Testing",
  description: "Reliable tests",
  version: "1.2.3",
  body: "PRIVATE BODY",
  frontmatter: { secret: "PRIVATE FRONTMATTER" },
  metadata: { creator_id: "PRIVATE ID" },
};
const privateSkill = {
  slug: "testing",
  display: { name: "Testing" },
  description: "Reliable tests",
  current_version: "2.0.0",
  validation: "valid",
  body: "PRIVATE BODY",
  creator_id: "PRIVATE ID",
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

async function errorCode(operation: Promise<unknown>, code: VaultErrorCode): Promise<void> {
  try {
    await operation;
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe(code);
    expect(String(error)).not.toContain("LEAK");
  }
}

describe("Skillpack metadata adapter", () => {
  test("public reads never send credentials and project only published metadata", async () => {
    const requests: string[] = [];
    const catalog = createSkillCatalog(
      fakeFetch((url, init) => {
        requests.push(url);
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json(url.includes("?") ? { skills: [publicSkill], next_offset: 50 } : publicSkill);
      }),
    );
    expect(await catalog.list({ source: "public" }, "LEAK KEY")).toEqual({
      items: [
        {
          reference: "team/testing",
          name: "Testing",
          description: "Reliable tests",
          visibility: "public",
          versions: ["1.2.3"],
        },
      ],
      nextOffset: 50,
    });
    expect(await catalog.versions({ source: "public", reference: "team/testing" }, "LEAK KEY")).toEqual({
      versions: ["1.2.3"],
    });
    expect(requests).toEqual([
      "https://skillpack.app/v1/public/catalog/skills?limit=50&offset=0",
      "https://skillpack.app/v1/public/catalog/skills/team/testing",
    ]);
  });

  test("private reads send the key only as a bearer and paginate validated metadata locally", async () => {
    const requests: string[] = [];
    const catalog = createSkillCatalog(
      fakeFetch((url, init) => {
        requests.push(url);
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer LEAK KEY");
        expect(init.redirect).toBe("error");
        if (url.endsWith("/versions"))
          return Response.json([
            { version: "2.0.0", validation: "valid", body: "PRIVATE BODY" },
            { version: "3.0.0", validation: "invalid" },
            { version: "2.1.0-beta.1", validation: "valid" },
          ]);
        return Response.json([
          { ...privateSkill, validation: "invalid", current_version: "garbage" },
          { ...privateSkill, current_version: null },
          ...Array.from({ length: 51 }, (_, index) => ({ ...privateSkill, slug: `skill-${index}` })),
        ]);
      }),
    );
    const first = await catalog.list({ source: "private" }, "LEAK KEY");
    expect(first.items).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    expect(await catalog.list({ source: "private", offset: 50 }, "LEAK KEY")).toEqual({
      items: [
        {
          reference: "skill-50",
          name: "Testing",
          description: "Reliable tests",
          visibility: "private",
          versions: ["2.0.0"],
        },
      ],
      nextOffset: null,
    });
    expect(await catalog.versions({ source: "private", reference: "testing" }, "LEAK KEY")).toEqual({
      versions: ["2.0.0", "2.1.0-beta.1"],
    });
    expect(requests).toEqual([
      "https://skillpack.app/v1/skills?lib=accessible",
      "https://skillpack.app/v1/skills?lib=accessible",
      "https://skillpack.app/v1/skills/testing/versions",
    ]);
  });

  test("invalid references, source mismatches, offsets and missing credentials fail before HTTP", async () => {
    let calls = 0;
    const catalog = createSkillCatalog(
      fakeFetch(() => {
        calls++;
        return Response.json([]);
      }),
    );
    for (const offset of [-1, 0.5, 10_001, Number.NaN]) {
      await errorCode(catalog.list({ source: "public", offset }), "invalid");
    }
    for (const [source, reference] of [
      ["public", "testing"],
      ["private", "team/testing"],
      ["public", "team/armada-tools"],
      ["private", "armada-tools"],
      ["public", "https://evil.test/testing"],
      ["private", "../testing"],
      ["private", "testing@1.2.3"],
      ["private", "a".repeat(257)],
    ] as const) {
      await errorCode(catalog.versions({ source, reference }), "invalid");
    }
    await errorCode(catalog.list({ source: "private" }), "missing_credential");
    await errorCode(catalog.versions({ source: "private", reference: "testing" }), "missing_credential");
    expect(calls).toBe(0);
  });

  test("HTTP refusal, absent public endpoint, redirects and transport errors disclose no upstream diagnostics", async () => {
    for (const status of [401, 403, 404, 500, 302]) {
      const catalog = createSkillCatalog(fakeFetch(() => new Response("LEAK UPSTREAM", { status })));
      await errorCode(
        catalog.list({ source: "private" }, "LEAK KEY"),
        status === 401 || status === 403 ? "credential_refused" : "unavailable",
      );
      await errorCode(catalog.list({ source: "public" }, "LEAK KEY"), "unavailable");
    }
    for (const failure of [new Error("LEAK KEY"), new VaultError("forbidden", "LEAK KEY")]) {
      const catalog = createSkillCatalog(
        fakeFetch(() => {
          throw failure;
        }),
      );
      await errorCode(catalog.list({ source: "public" }), "unavailable");
    }
  });

  test("malformed upstream metadata and pagination fail closed", async () => {
    for (const response of [
      {},
      { skills: [], next_offset: 0 },
      { skills: [], next_offset: 10_001 },
      { skills: [], next_offset: 1.5 },
      { skills: [], next_offset: "50" },
      { skills: Array(51).fill(publicSkill), next_offset: null },
      { skills: [{ ...publicSkill, version: "latest" }], next_offset: null },
      { skills: [{ ...publicSkill, skill_slug: "armada-tools" }], next_offset: null },
      { skills: [{ ...publicSkill, description: "x".repeat(8193) }], next_offset: null },
    ]) {
      await errorCode(
        createSkillCatalog(fakeFetch(() => Response.json(response))).list({ source: "public" }),
        "unavailable",
      );
    }
    for (const response of [
      {},
      [{ ...privateSkill, current_version: "^1.0.0" }],
      [{ ...privateSkill, validation: null }],
    ]) {
      await errorCode(
        createSkillCatalog(fakeFetch(() => Response.json(response))).list({ source: "private" }, "KEY"),
        "unavailable",
      );
    }
    await errorCode(
      createSkillCatalog(fakeFetch(() => Response.json([{ version: "latest", validation: "valid" }]))).versions(
        { source: "private", reference: "testing" },
        "KEY",
      ),
      "unavailable",
    );
    await errorCode(
      createSkillCatalog(fakeFetch(() => Response.json({ ...publicSkill, skill_slug: "other" }))).versions({
        source: "public",
        reference: "team/testing",
      }),
      "unavailable",
    );
  });

  test("stream cap rejects oversized bodies before JSON and cancels the stream", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const catalog = createSkillCatalog(fakeFetch(() => new Response(body)));
    await errorCode(catalog.list({ source: "public" }), "unavailable");
    expect(canceled).toBe(true);
    await errorCode(
      createSkillCatalog(fakeFetch(() => new Response("LEAK not JSON"))).list({ source: "public" }),
      "unavailable",
    );
  });
});
