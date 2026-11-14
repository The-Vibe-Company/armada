/** Durable owner requests. These records grant no execution authority. */
export interface OttoObjective {
  id: string;
  org_id: string;
  owner_id: string;
  repository: string;
  request: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface OttoObjectiveMessage {
  id: string;
  objective_id: string;
  org_id: string;
  owner_id: string;
  body: string;
  revision: number;
  created_at: string;
}
