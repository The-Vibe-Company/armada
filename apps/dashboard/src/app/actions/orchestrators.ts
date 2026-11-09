"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formString } from "@/lib/action";
import { listGoldens } from "@/lib/data/goldens";
import { listModelAccounts, viewerOrchestrators } from "@/lib/data/orchestrators";
import { isSelectedOrganization } from "@/lib/data/selected-org";
import { requireViewer } from "@/lib/data/viewer";
import { OrchestratorApiError, type OrchestratorFailure } from "@/lib/orchestrator-api";
import {
  type Command,
  isIdempotencyKey,
  isOrchestratorId,
  OrchestratorContractError,
  orchestratorCreateRequest,
} from "@/lib/orchestrators";
import { goldenRepositoryDirs } from "@/lib/repository-context";
import { createClient } from "@/lib/supabase/server";

/**
 * `failure` tells the form what to do with its `Idempotency-Key`: an `uncertain` outcome keeps it, so sending again
 * cannot apply the request twice; any other answer was definite, and the next attempt is a new request.
 */
export type OrchestratorResult =
  | { ok: true; message: string }
  | { ok: false; error: string; failure: OrchestratorFailure | "invalid" };

const invalid = (error: string): OrchestratorResult => ({ ok: false, error, failure: "invalid" });

function failed(error: unknown): OrchestratorResult {
  if (error instanceof OrchestratorApiError) return { ok: false, error: error.message, failure: error.failure };
  // The server accepted the request (2xx) but its receipt is in another contract version: say so, never crash.
  if (error instanceof OrchestratorContractError)
    return {
      ok: false,
      error: `Accepted, but ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`,
      failure: "uncertain",
    };
  throw error;
}

/** Creates an orchestrator through the server, then opens it. The server persists its identity before any machine. */
export async function createOrchestrator(
  _previous: OrchestratorResult | null,
  data: FormData,
): Promise<OrchestratorResult> {
  const viewer = await requireViewer();
  const org = formString(data, "org");
  const key = formString(data, "idempotency_key");
  if (!isIdempotencyKey(key)) return invalid("That request is not valid. Reload and try again.");
  if (!(await isSelectedOrganization(org))) return invalid("Switch to that organization first.");
  const api = viewerOrchestrators(viewer);
  if (!api) return invalid("The Armada server is not configured for this dashboard.");
  const goldens = await listGoldens(await createClient());
  const golden = goldens.find((row) => row.id === formString(data, "golden") && row.provider_snapshot_id);
  if (!golden) return invalid("Choose a golden.");
  const accounts = await listModelAccounts(viewer, org);
  if (!accounts.ok) return invalid(accounts.reason);
  const request = orchestratorCreateRequest(
    {
      org,
      name: formString(data, "name"),
      golden: golden.id,
      provider: formString(data, "provider"),
      harness: formString(data, "harness"),
      model: formString(data, "model"),
      otherModel: formString(data, "other_model"),
      reasoningEffort: formString(data, "reasoning_effort"),
      account: formString(data, "account"),
      repo: formString(data, "repo"),
      idleSeconds: formString(data, "idle_seconds"),
    },
    { provider: golden.provider, repositories: goldenRepositoryDirs(golden.config), accounts: accounts.accounts },
  );
  if (!request.ok) return invalid(request.error);
  let orchestratorId: string;
  try {
    orchestratorId = (await api.create(request.value, key)).orchestratorId;
  } catch (error) {
    return failed(error);
  }
  revalidatePath("/orchestrators");
  redirect(`/orchestrators/${encodeURIComponent(orchestratorId)}`);
}

const COMMANDS: readonly Command[] = ["message", "steer", "stop", "resume"];

const DONE: Record<Command, string> = {
  message: "Sent.",
  steer: "Steered.",
  stop: "Stop requested. The conversation is kept.",
  resume: "Resume requested.",
};

/**
 * Message, steer, stop or resume, fenced by the revision the page last saw. A stale revision is refused by the server
 * (never retried here with a newer one): the page reloads and the person decides again.
 */
export async function orchestratorCommand(
  _previous: OrchestratorResult | null,
  data: FormData,
): Promise<OrchestratorResult> {
  const id = formString(data, "orchestrator");
  const command = COMMANDS.find((candidate) => candidate === formString(data, "command"));
  const revision = Number(formString(data, "expected_revision"));
  const key = formString(data, "idempotency_key");
  const text = formString(data, "text").trim();
  if (!isOrchestratorId(id) || !command || !Number.isSafeInteger(revision) || revision < 0 || !isIdempotencyKey(key))
    return invalid("That request is not valid. Reload and try again.");
  if ((command === "message" || command === "steer") && !text) return invalid("Write the message to send.");
  const api = viewerOrchestrators(await requireViewer());
  if (!api) return invalid("The Armada server is not configured for this dashboard.");
  try {
    await api.command(id, command, revision, key, command === "message" || command === "steer" ? text : undefined);
  } catch (error) {
    return failed(error);
  }
  revalidatePath(`/orchestrators/${id}`);
  return { ok: true, message: DONE[command] };
}
