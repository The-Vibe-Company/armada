import type { Harness } from "./contract.ts";
import type { ModalBinding, SandboxProviderId } from "./sandbox-provider.ts";
export interface TemplateDefinition {
  goldenId: string;
  provider: SandboxProviderId;
  goldenBinding: ModalBinding | null;
  harness: Harness;
  model: string;
  reasoningEffort: string;
  modelAccount?: { id: string; version: number };
  /** Stable connection identities; live connected grant versions resolve only at launch admission. */
  connections: string[];
  variables: { key: string; variableId: string; version: number }[];
  /** Value-free references; optional for revisions published before secret bindings. */
  secrets?: { key: string; secretId: string; version: number }[];
  skills: string[];
}
export interface LaunchTemplate {
  id: string;
  orgId: string;
  ownerId: string;
  scope: "personal" | "org";
  name: string;
  currentRevision: number;
  status: "active" | "deleted";
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** Closed, value-free launch refusal diagnostics shared by API clients and receipts. */
export const TEMPLATE_REFUSAL_HELP = {
  reference_unavailable: "A template reference is missing or inaccessible. Check the template definition.",
  environment_unavailable:
    "Template golden is removed, unavailable or inaccessible. Publish a revision with an eligible golden.",
  environment_binding_changed:
    "Template golden provider binding changed. Publish a revision with the current environment binding.",
  environment_snapshot_unavailable:
    "Template golden snapshot is unavailable or retired. Check the golden before retrying.",
  environment_admission_unavailable:
    "Template golden became unavailable during admission. Check the golden before retrying.",
  connection_unavailable:
    "Template connection is unknown, disabled, disconnected or inaccessible. Check the exact connection ID.",
  connection_version_changed:
    "Template connection grant changed during admission. Check the connection before retrying.",
  secret_unavailable: "Secret is missing, expired, revoked or inaccessible. Check its reference.",
  secret_version_changed: "Secret version changed. Publish a revision with its current version.",
  secret_delivery_unavailable: "Secret bindings are saved, but template secret delivery is not available yet.",
  variable_unavailable: "Readable variable is missing or inaccessible. Check its reference.",
  variable_version_changed: "Readable variable version changed. Publish a revision with its current version.",
  variable_delivery_unavailable:
    "Readable variable delivery is unavailable for this environment. Check runtime support.",
  model_account_unavailable:
    "No usable model account is available for this agent in this organization. Add one in Build > Harness or choose another agent.",
  model_account_ambiguous:
    "Several model accounts can run this agent. Set a default in Build > Harness or publish a revision with an explicit account binding.",
  model_account_refused:
    "The selected model account is expired, revoked, changed or incompatible. Reconnect it in Build > Harness or publish a revision with a usable account binding.",
  model_account_version_changed:
    "Template model account version changed. Publish a revision with the current account version.",
  model_account_incompatible:
    "Template model account is incompatible with the selected harness. Publish a compatible account binding.",
  template_revision_changed: "Template revision changed during admission. Get the current revision before retrying.",
  authorization_changed: "Template launch authorization changed during admission. Check current membership and access.",
} as const;
export type TemplateRefusalReason = keyof typeof TEMPLATE_REFUSAL_HELP;

export function templateRefusalHelp(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(TEMPLATE_REFUSAL_HELP, reason)
    ? TEMPLATE_REFUSAL_HELP[reason as TemplateRefusalReason]
    : "Template launch could not proceed. Check current access, references and environment availability.";
}
