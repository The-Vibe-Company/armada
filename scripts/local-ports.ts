/** Readiness is not ownership: fixture runners must start their own servers. */
export function assertLocalPortsAvailable(ports: readonly number[]): void {
  for (const port of ports) {
    try {
      const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      probe.stop(true);
    } catch (cause) {
      // Best-effort diagnostics only; missing ss must never permit server reuse.
      let owner = "Owner unavailable (use ss -ltnp or lsof -i to identify it).";
      try {
        const result = Bun.spawnSync(["ss", "-ltnp", `sport = :${port}`]);
        const output = result.stdout.toString().trim();
        if (result.exitCode === 0 && output) owner = output;
      } catch {}
      throw new Error(`Port ${port} is unavailable. Stop its listener before starting this runner.\n${owner}`, {
        cause,
      });
    }
  }
}
