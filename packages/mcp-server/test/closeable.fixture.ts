export function closeableFixture<T extends { close(): Promise<void> }>(open: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  let ready: T | undefined;
  return {
    async setup() {
      const opening = open();
      pending = opening;
      const database = await opening;
      if (pending === opening) ready = database;
    },
    get() {
      if (!ready) throw new Error("Fixture is not open");
      return ready;
    },
    async close() {
      const opening = pending;
      pending = undefined;
      ready = undefined;
      const database = await opening?.catch(() => undefined);
      await database?.close();
    },
  };
}
