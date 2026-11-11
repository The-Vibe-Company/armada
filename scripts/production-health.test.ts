import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { checkProductionHealth } from "./production-health.ts";

afterEach(() => jest.restoreAllMocks());

test("production probe rejects downtime, redirects, unrelated 200 pages, and missing configuration", async () => {
  const request = spyOn(globalThis, "fetch");
  for (const response of [
    new Response("down", { status: 503 }),
    new Response("", { status: 302 }),
    Response.json({ ok: true }),
    Response.json({ ok: false, version: "2.0.0" }),
    new Response("<html>login</html>"),
  ]) {
    request.mockResolvedValueOnce(response);
    await expect(checkProductionHealth("https://production.example")).rejects.toThrow();
  }
  await expect(checkProductionHealth("")).rejects.toThrow();
  request.mockResolvedValueOnce(Response.json({ ok: true, version: "2.0.0" }));
  await checkProductionHealth("https://production.example");
  expect(request.mock.calls.at(-1)?.[0].toString()).toBe("https://production.example/healthz");
  request.mockResolvedValueOnce(Response.json({ ok: true, version: "2.0.0" }));
  await expect(checkProductionHealth("https://production.example", "2.1.0")).rejects.toThrow("version");
  request.mockResolvedValueOnce(Response.json({ ok: true, version: "2.1.0" }));
  await checkProductionHealth("https://production.example", "2.1.0");
});
