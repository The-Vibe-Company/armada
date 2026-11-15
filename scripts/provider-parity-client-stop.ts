import { type ClientProofIo, createParityClients, type ProofClient } from "./provider-parity-clients.ts";

interface Io extends ClientProofIo {
  sleep(ms: number): Promise<void>;
  verified(client: ProofClient): void;
  resume(): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
/** Both clients stop active compute; the same owned sandbox is woken between them. */
export async function probeClientStop(input: { id: string; org: string; origin: string; token: string }, io: Io) {
  const session = await createParityClients(input, io, "stop");
  const status = () =>
    session.api.request<{ id?: string; status?: string }>("/api/v1/sandbox/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: input.id, org: input.org }),
    });
  for (const client of ["dashboard", "cli"] as const) {
    await session.run(client, async () => {
      const before = await status();
      if (before.id !== input.id || !["ready", "running"].includes(before.status ?? ""))
        session.fail("client_stop_not_active");
      const result =
        client === "dashboard"
          ? await session.dashboard.stop(input.id)
          : await session.command([input.id, "--org", input.org, "--json"]);
      const receipt = object(result);
      if (receipt.id !== input.id || typeof receipt.status !== "string") session.fail("invalid_client_stop_receipt");
      let stopped = false;
      for (let reads = 0; reads < 110 && io.now() < io.until; reads++) {
        const current = await status();
        if (io.now() > io.until) session.fail("client_stop_timeout");
        if (current.id !== input.id) session.fail("invalid_client_stop_receipt");
        if (current.status === "stopped") {
          stopped = true;
          break;
        }
        if (!["ready", "running", "stopping"].includes(current.status ?? "")) session.fail("client_stop_not_confirmed");
        await io.sleep(Math.min(1000, Math.max(0, io.until - io.now())));
      }
      if (!stopped) session.fail("client_stop_timeout");
      io.verified(client);
    });
    if (client === "dashboard") await io.resume();
  }
}
