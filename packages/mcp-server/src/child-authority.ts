import type { Harness, Sql } from "@armada/core/server";

/** Structural projection of actual #661 DelegatedAuthority.admit. Never a user Caller. */
export interface ChildAuthority {
  admit<T>(
    token: string,
    request: {
      method: string;
      childId?: string;
      goldenId?: string;
      harness?: Harness;
      credentialId?: string;
      credentialVersion?: number;
    },
    reserve: (
      sql: Sql,
      principal: {
        kind: "orchestrator";
        orchestratorId: string;
        ownerId: string;
        orgId: string;
        role: "admin" | "member";
      },
    ) => Promise<T>,
  ): Promise<T>;
}
