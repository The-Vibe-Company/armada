import { expect, test } from "bun:test";
import { closeableFixture } from "./closeable.fixture.ts";

test("fixture closes a resource that becomes ready after teardown starts", async () => {
  let closed = 0;
  const engine = {
    async close() {
      closed += 1;
    },
  };
  const opening = Promise.withResolvers<typeof engine>();
  const fixture = closeableFixture(() => opening.promise);
  const setup = fixture.setup();
  const teardown = fixture.close();

  opening.resolve(engine);
  await Promise.all([setup, teardown]);

  expect(closed).toBe(1);
  expect(() => fixture.get()).toThrow("Fixture is not open");
});
