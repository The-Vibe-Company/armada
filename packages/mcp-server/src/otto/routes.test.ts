import { expect, test } from "bun:test";
import { createOttoRoutes } from "./routes.ts";

test("Otto web routes remain mounted without observer configuration", async () => {
  const routes = createOttoRoutes({
    sql: {
      query: async () => {
        throw Error("unauthenticated read must not reach storage");
      },
    },
    scopes: [],
    reader: { credentials: async () => [], orgBoatKey: async () => null },
    authenticate: async () => ({ ok: false }),
    canReadRepository: async () => false,
  });
  for (const path of ["objectives", "evidence", "repositories", "summary", "engine"]) {
    let response: Response | null = null;
    for (const route of routes) {
      response = await route(new Request(`https://armada.test/api/v1/otto/${path}`));
      if (response) break;
    }
    expect(response?.status).toBe(401);
  }
  expect(
    (await routes[0]!(new Request("https://armada.test/api/v1/otto/interviews/11111111-1111-4111-8111-111111111111")))
      ?.status,
  ).toBe(401);
});
