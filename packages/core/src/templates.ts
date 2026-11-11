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
  variable_unavailable: "Readable variable is missing or inaccessible. Check its reference.",
  variable_version_changed: "Readable variable version changed. Publish a revision with its current version.",
  variable_delivery_unavailable:
    "Readable variable delivery is unavailable for this environment. Check runtime support.",
  model_account_unavailable: "Template model account is missing or inaccessible. Check the account binding.",
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
