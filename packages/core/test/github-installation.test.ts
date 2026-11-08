import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { githubAppJwt, mintInstallationToken } from "../src/server.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const app = { appId: "42", privateKey };
describe("GitHub installation token", () => {
  test("mints only a scoped one-hour token and never includes it in request URL", async () => {
    let seen = "";
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = `${url} ${init?.body}`;
      return Response.json({ token: "ghs_test_secret", expires_at: "2026-01-01T01:00:00Z" });
    }) as typeof fetch;
    const result = await mintInstallationToken(app, 7, [11, 12], {
      now: () => new Date("2026-01-01T00:00:00Z"),
      fetch: fake,
    });
    expect(result).toMatchObject({ installationId: 7 });
    expect(seen).toContain("repository_ids");
    expect(seen).not.toContain("ghs_test_secret");
  });
  test("rejects missing scope and impossible expiry", async () => {
    await expect(mintInstallationToken(app, 0, [])).rejects.toThrow("valid installation");
    const fake = (async () =>
      Response.json({ token: "x", expires_at: "2099-01-01T00:00:00Z" })) as unknown as typeof fetch;
    await expect(mintInstallationToken(app, 1, [2], { fetch: fake })).rejects.toThrow(
      "invalid installation token lifetime",
    );
  });
  test("creates a three-part signed JWT", () => expect(githubAppJwt(app).split(".")).toHaveLength(3));
});
