export type DelegatedScope = "worker:launch" | "worker:read" | "worker:message" | "worker:stop" | "worker:extend";

export interface SkillReceipt {
  /** Authenticated registry workspace; absent for anonymous public catalog receipts. */
  workspaceId?: string;
  reference: string;
  version: string;
  skillId: string;
  checksum: string;
  origin: string;
}

/** Qualified references select anonymous catalog; bare slugs select the authenticated workspace. */
export { SKILL_PIN_PATTERN } from "./skill-pins.ts";
