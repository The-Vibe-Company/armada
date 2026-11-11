/** Retry only connection admission failures, never arbitrary SQL or configuration errors.
 * No transaction/body replay is exposed to request handlers.
 */
export async function retryDatabaseBoot(initialize: () => Promise<void>, log: (line: string) => void) {
  const deadline = Date.now() + 120_000;
  let delay = 250;
  for (;;) {
    try {
      await initialize();
      return;
    } catch (error) {
      const fields = error as { code?: unknown; errno?: unknown; message?: unknown };
      const supavisorAdmission =
        fields?.code === "ERR_POSTGRES_SERVER_ERROR" &&
        fields.errno === "XX000" &&
        typeof fields.message === "string" &&
        /^\((EMAXCONNSESSION|EMAXCONN)\)/.test(fields.message);
      const retryable =
        supavisorAdmission ||
        [fields?.code, fields?.errno].some((code) =>
          [
            "53300",
            "08000",
            "08003",
            "08006",
            "57P01",
            "57P03",
            "ERR_POSTGRES_CONNECTION_REFUSED",
            "ERR_POSTGRES_CONNECTION_FAILED",
            "ERR_POSTGRES_CONNECTION_CLOSED",
            "ERR_POSTGRES_CONNECTION_TIMEOUT",
          ].includes(String(code)),
        );
      if (!retryable || Date.now() + delay >= deadline) throw error;
      // Fixed text only: driver messages may contain connection credentials.
      log("armada-server: database admission unavailable; retrying boot");
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 5_000);
    }
  }
}
