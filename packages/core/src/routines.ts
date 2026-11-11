/** A scheduled launch definition. Slice one stores paused definitions only; it never launches work. */
export interface Routine {
  id: string;
  orgId: string;
  ownerId: string;
  scope: "personal" | "org";
  name: string;
  templateId: string;
  templateRevision: number;
  prompt: string;
  intervalHours: number;
  maxRunsPerDay: number;
  ttlSeconds: number;
  status: "paused" | "deleted";
  version: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}
