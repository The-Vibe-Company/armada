// The Armada GitHub App's webhook (THE-853): pull requests, check suites and
// runs, commit statuses. Marks the readings of the repository, answers at
// once, and refreshes them after the answer. Both proxy gates let it through:
// it checks the app's webhook secret itself (lib/webhooks.ts).
import { after } from "next/server";
import { appDatabase } from "@/lib/app-db";
import { refreshMarked } from "@/lib/server";
import { handleGithubWebhook, webhookSecretsOf } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleGithubWebhook(request, {
    secrets: webhookSecretsOf(process.env),
    database: appDatabase,
    refresh: (keys) => after(() => refreshMarked(keys)),
  });
}
