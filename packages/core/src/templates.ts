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
