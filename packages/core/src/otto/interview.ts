import type { OttoEngine } from "./engine.ts";

export interface OttoInterviewDecision {
  id: string;
  question: string;
  recommendation: string;
  answer: string | null;
  source: string | null;
  reversible: boolean;
  dependsOn: string[];
}
/** Frontier order supplies the visible 1-based question numbers; there is no question cap. */
export interface OttoInterviewRound {
  decisions: OttoInterviewDecision[];
  assumptions: { text: string; source: string }[];
  frontier: string[];
}
export interface OttoInterview {
  objectiveId: string;
  revision: number;
  engine: OttoEngine;
  goldenId: string;
  sandboxId: string | null;
  round: OttoInterviewRound | null;
  answers: { revision: number; body: string; enough: boolean }[];
  enough: boolean;
}
