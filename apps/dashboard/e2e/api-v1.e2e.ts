import { expect, test } from "@playwright/test";

test("API v1 reaches its bearer route without a dashboard cookie", async ({ request }) => {
  const publicResponse = await request.post("/api/v1/auth/email/start", {
    data: {
      email: "alice@example.com",
      redirect_uri: "http://127.0.0.1:43123/callback",
      code_challenge: "a".repeat(43),
      state: "abcdefgh",
    },
  });
  expect(publicResponse.status()).toBe(200);

  const privateResponse = await request.post("/api/v1/golden/list", { data: {} });
  expect(privateResponse.status()).toBe(401);
  expect(await privateResponse.json()).toEqual({ error: "Unauthorized." });

  const bearerResponse = await request.post("/api/v1/golden/list", {
    data: {},
    headers: { authorization: "Bearer e2e-valid-bearer" },
  });
  expect(bearerResponse.status()).toBe(200);
  expect(await bearerResponse.json()).toEqual({ goldens: [] });

  const unknownResponse = await request.post("/api/v1/unknown", {
    data: {},
    headers: { authorization: "Bearer e2e-valid-bearer" },
  });
  expect(unknownResponse.status()).toBe(404);
  expect(await unknownResponse.json()).toEqual({ error: "Not found." });

  const dashboardResponse = await request.get("/sandboxes", { maxRedirects: 0 });
  expect(dashboardResponse.status()).toBe(307);
  expect(dashboardResponse.headers().location).toBe("/login?next=%2Fsandboxes");
});
