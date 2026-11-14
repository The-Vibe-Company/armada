/** Durable typed blockers. Resolving a wait is not evidence of completed work. */
export type OttoWaitKind = "ci" | "verification" | "slot" | "human" | "access";
export type OttoWaitReason =
  | "approval"
  | "irreversible"
  | "access"
  | "two_failed_attempts"
  | "budget"
  | "reversible"
  | "observation";
export interface OttoWaitChoice {
  id: string;
  label: string;
}
export interface OttoWait {
  id: string;
  objective_id: string;
  org_id: string;
  owner_id: string;
  dedupe_key: string;
  kind: OttoWaitKind;
  reason: OttoWaitReason;
  phase: "interview" | "work";
  question: string;
  choices: OttoWaitChoice[];
  default_choice: string | null;
  connection_url: string | null;
  status: "open" | "answered" | "defaulted" | "parked";
  resolution: string | null;
  created_at: string;
  deadline_at: string;
  reminded_at: string | null;
}
export interface OttoWaitInput {
  objective_id: string;
  dedupe_key: string;
  kind: OttoWaitKind;
  reason: OttoWaitReason;
  phase: "interview" | "work";
  question: string;
  choices: OttoWaitChoice[];
  default_choice?: string | null;
  connection_url?: string | null;
}
