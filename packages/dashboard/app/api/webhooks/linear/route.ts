// Linear's webhook (THE-853): marks the readings a delivery concerns, answers
// at once, and refreshes them after the answer. Both proxy gates let it
// through: it checks Linear's signature itself (lib/webhooks.ts).
import { after } from "next/server";
import { appDatabase } from "@/lib/app-db";
import { refreshMarked } from "@/lib/server";
import { handleLinearWebhook, webhookSecretsOf } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleLinearWebhook(request, {
    secrets: webhookSecretsOf(process.env),
    database: appDatabase,
    refresh: (keys) => after(() => refreshMarked(keys)),
  });
}
