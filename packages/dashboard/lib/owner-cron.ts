// Optional scheduler entry; production has no enabled cron. The route checks
// its own bearer before opening accounts or the database, behind both gates.
import { timingSafeEqual } from "node:crypto";
import type { Database } from "./db";
import { ownerTick, safeWebhookFetch } from "./owner-push";
import type { VaultMode } from "./vault";

export async function ownerCron(
  request: Request,
  deps: {
    secret: string | undefined;
    accounts: () => Promise<{ client: Database; settings: { baseUrl: string } } | null>;
    vault: () => VaultMode;
    now?: () => Date;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  },
): Promise<Response> {
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${deps.secret ?? ""}`);
  if (!deps.secret || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const a = await deps.accounts();
  const vault = deps.vault();
  if (!a || vault.kind !== "on") return Response.json({ enabled: false });
  try {
    const rs = await a.client.query(
      `SELECT DISTINCT organization FROM owner_channels WHERE alerts AND paused_reason IS NULL`,
    );
    for (const row of rs.rows)
      await ownerTick(a.client, {
        organization: String(row.organization),
        now: deps.now ?? (() => new Date()),
        vault: vault.key,
        fetch: deps.fetch ?? safeWebhookFetch,
        baseUrl: a.settings.baseUrl,
      });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "owner tick failed" }, { status: 503 });
  }
}
