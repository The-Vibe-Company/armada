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
  connections: { id: string; version: number; generation: number }[];
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
