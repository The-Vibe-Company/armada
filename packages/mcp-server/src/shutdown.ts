/** Keep the process alive for admitted work, but never beyond the host's stop window. */
export function installShutdownHandlers(server: { stop(force?: boolean): Promise<void> }) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.info("armada-server: draining admitted requests");
    // Leave headroom for the host's SIGKILL. A deadline is failure, not a clean drain.
    const deadline = setTimeout(() => {
      console.error("armada-server: shutdown deadline exceeded; in-flight work may need reconciliation");
      void server.stop(true);
      process.exit(1);
    }, 25_000);
    void server.stop(false).then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => {
        console.error("armada-server: shutdown failed");
        clearTimeout(deadline);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
