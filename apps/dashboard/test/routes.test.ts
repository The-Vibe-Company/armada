import { describe, expect, test } from "bun:test";
import { isPublicPath, originFromHeaders, safeNextPath } from "../src/lib/routes.ts";

const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });

describe("routes", () => {
  test("only the login and auth paths are open to a signed-out visitor", () => {
    expect(["/login", "/login/", "/auth/callback", "/auth/signout"].every(isPublicPath)).toBe(true);
    expect(["/", "/sandboxes", "/loginx", "/api/sandboxes/1/events", "/authors"].some(isPublicPath)).toBe(false);
  });

  test("a next path is kept only when it stays on this site", () => {
    expect(safeNextPath("/credentials")).toBe("/credentials");
    expect(safeNextPath("/sandboxes/abc?page=2")).toBe("/sandboxes/abc?page=2");
    for (const hostile of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/a\nb",
    ]) {
      expect(safeNextPath(hostile)).toBe("/sandboxes");
    }
    expect(safeNextPath(null)).toBe("/sandboxes");
    expect(safeNextPath("/login?next=/login")).toBe("/sandboxes");
  });

  test("the origin comes from the forwarded headers behind a proxy", () => {
    expect(
      originFromHeaders(
        headers({ host: "internal:3000", "x-forwarded-host": "armada.example", "x-forwarded-proto": "https" }),
      ),
    ).toBe("https://armada.example");
    expect(originFromHeaders(headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(originFromHeaders(headers({ host: "preview-abc.vercel.app" }))).toBe("https://preview-abc.vercel.app");
    expect(originFromHeaders(headers({}), "https://fallback.example/x")).toBe("https://fallback.example");
  });
});
