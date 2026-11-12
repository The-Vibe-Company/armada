import type { Sql } from "@armada/core";
import { requireDatabaseSchema } from "./database-schema.ts";

/** Observe the serving pool, never replay writes or create another connection pool.
 * A timed-out query remains single-flight until its actual driver promise settles. */
export function createDatabaseReadiness(sql: Sql): () => Promise<boolean> {
  let active: Promise<boolean> | undefined;
  let cached = false;
  let validUntil = 0;
  return () => {
    if (active) return active;
    if (Date.now() < validUntil) return Promise.resolve(cached);
    const answer = Promise.withResolvers<boolean>();
    active = answer.promise;
    let answered = false;
    const finish = (ready: boolean) => {
      if (answered) return;
      answered = true;
      cached = ready;
      validUntil = Date.now() + 1_000;
      answer.resolve(ready);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    // The deadline bounds the HTTP answer, not the underlying database operation.
    // Do not publish a late success or enqueue further probes behind a stuck one.
    void Promise.resolve()
      .then(() => requireDatabaseSchema(sql))
      .then(
        () => finish(true),
        () => finish(false),
      )
      .finally(() => {
        clearTimeout(timer);
        active = undefined;
      });
    return answer.promise;
  };
}
