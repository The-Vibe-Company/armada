import { expect, test } from "bun:test";
import { databaseFixture } from "./migrated-database.ts";

test("database fixture closes an engine that opens after teardown starts", async () => {
  let closed = 0;
  const engine = {
    async close() {
      closed += 1;
    },
  };
  const opening = Promise.withResolvers<typeof engine>();
  const fixture = databaseFixture(() => opening.promise);
  const setup = fixture.setup();
  const teardown = fixture.close();

  opening.resolve(engine);
  await Promise.all([setup, teardown]);

  expect(closed).toBe(1);
  expect(() => fixture.get()).toThrow("Database fixture is not open");
});
