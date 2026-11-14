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
    authenticate: async () => ({ ok: false }),
    canReadRepository: async () => false,
  });
  for (const path of ["objectives", "evidence", "repositories", "summary"]) {
    let response: Response | null = null;
    for (const route of routes) {
      response = await route(new Request(`https://armada.test/api/v1/otto/${path}`));
      if (response) break;
    }
    expect(response?.status).toBe(401);
  }
});
