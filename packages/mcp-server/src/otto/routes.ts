import { resolveOttoRepositories, type Sql } from "@armada/core/server";
import type { Caller, CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { createOttoApi } from "./api.ts";
import { createOttoEvidenceApi } from "./evidence-api.ts";
import { createOttoObjectivesApi } from "./objectives-api.ts";
import type { OttoScope } from "./observation.ts";

/** All web endpoints mount together; absent observation configuration is an empty scope, not a missing route. */
export function createOttoRoutes(options: {
  sql: Sql;
  scopes: readonly OttoScope[];
  authenticate: (request: Request) => Promise<CallerResult>;
  canReadRepository: (caller: Caller, repository: string) => Promise<boolean>;
  observerToken?: string | undefined;
  encryptionKey?: string | undefined;
}): Route[] {
  const { sql, scopes, authenticate } = options;
  const canReadRepository = async (caller: Caller, repository: string) => {
    for (const { orgId } of scopes.filter((scope) => scope.repository === repository)) {
      if ((await resolveOttoRepositories(sql, caller, orgId, scopes)).includes(repository))
        return options.canReadRepository(caller, repository);
    }
    return false;
  };
  return [
    createOttoObjectivesApi(sql, authenticate),
    createOttoEvidenceApi(sql, scopes, authenticate, options.observerToken, canReadRepository),
    createOttoApi(sql, scopes, authenticate, undefined, options.encryptionKey, canReadRepository),
  ];
}
