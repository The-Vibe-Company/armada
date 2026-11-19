import { createHmac } from "node:crypto";
import { inspect } from "node:util";

export async function smokeSdk({ Armada, ArmadaError, verifyWebhookSignature }) {
  const seen = [];
  const armada = new Armada({
    token: "smoke",
    url: "https://armada.invalid",
    fetch: async (url) => {
      seen.push(new URL(String(url)).pathname);
      return Response.json({ error: { code: "outcome_unknown" } }, { status: 503 });
    },
  });
  const error = await armada.status({ id: "sandbox" }).catch((caught) => caught);
  if (!(error instanceof ArmadaError) || error.code !== "outcome_unknown" || seen.length !== 1) {
    throw new Error(`unexpected SDK result ${error} for ${seen}`);
  }
  let bearer;
  const logged = new Armada({
    token: "smoke_secret",
    url: "https://armada.invalid",
    fetch: async (_url, init) => {
      bearer = new Headers(init.headers).get("authorization");
      return Response.json({ id: "s" });
    },
  });
  if (
    JSON.stringify(logged).includes("smoke_secret") ||
    inspect(logged, { depth: 10, showHidden: true }).includes("smoke_secret")
  ) {
    throw new Error("a serialized or inspected SDK client exposes its token");
  }
  await logged.status({ id: "s" });
  if (bearer !== "Bearer smoke_secret") throw new Error(`unexpected SDK authorization ${bearer}`);
  const body = "{}",
    id = "evt",
    timestamp = "1700000000";
  const signature = `v1=${createHmac("sha256", "secret").update(`${timestamp}.${id}.${body}`).digest("hex")}`;
  const headers = {
    "armada-webhook-id": id,
    "armada-webhook-timestamp": timestamp,
    "armada-webhook-signature": signature,
  };
  if (
    !(await verifyWebhookSignature({
      secret: "secret",
      body,
      headers: new Headers(headers),
      now: Number(timestamp) * 1000,
    }))
  ) {
    throw new Error("webhook signature rejected");
  }
  const docker = { org: "o", provider: "docker", hostId: "h", harness: "codex", requestId: "r" };
  let launchBody;
  const receipt = await new Armada({
    token: "smoke",
    url: "https://armada.invalid",
    fetch: async (_url, init) => {
      launchBody = init.body;
      return Response.json({
        sandbox: { id: "s", provider: "docker", status: "running", hostId: "h" },
        golden: null,
        ttlSeconds: 60,
        expiresAt: "2026-01-01T00:00:00.000Z",
      });
    },
  }).launch(docker);
  if (launchBody !== JSON.stringify(docker) || receipt.golden !== null || receipt.sandbox.id !== "s") {
    throw new Error(`unexpected Docker launch ${launchBody} -> ${JSON.stringify(receipt)}`);
  }
}
