import { mergeSkillPins } from "./skill-merge.ts";

type AccountPreference = { credentialId: string | null; model: string | null };

export function applyLaunchAccountDefaults<T extends { credentialId?: unknown; model?: unknown }>(
  request: T,
  preference: AccountPreference | undefined,
): T {
  if (!preference || (request.credentialId !== undefined && request.credentialId !== preference.credentialId))
    return request;
  return {
    ...request,
    ...(request.credentialId === undefined && preference.credentialId ? { credentialId: preference.credentialId } : {}),
    ...(request.model === undefined && preference.model ? { model: preference.model } : {}),
  };
}

export async function resolveLaunchSkills(
  request: { skipSkillDefaults?: boolean; skills?: string[] },
  defaults: () => Promise<{ environment?: string[]; org: string[]; personal: string[] } | undefined> | undefined,
  invalid: () => Error,
): Promise<string[]> {
  const pins = request.skipSkillDefaults ? undefined : await defaults();
  try {
    return mergeSkillPins(pins?.environment ?? [], pins?.org ?? [], pins?.personal ?? [], request.skills ?? []);
  } catch {
    throw invalid();
  }
}

export async function resolveLaunchConnections(
  requested: string[] | undefined,
  defaults: (() => Promise<string[]> | undefined) | undefined,
  validate: (ids: string[]) => Promise<void>,
): Promise<string[]> {
  const ids = [...new Set(requested ?? (await defaults?.()) ?? [])];
  await validate(ids);
  return ids;
}

/** Admit the selected account before any additional pre-allocation checks, under the caller's fence. */
export async function admitLaunchPlan(
  admitAccount: () => Promise<void> | undefined,
  beforeAllocation: () => Promise<void> | undefined,
): Promise<void> {
  await admitAccount();
  await beforeAllocation();
}

/** Placement owns the admission fence and the allocation performed under it. */
export interface LaunchPlacement<Resolved, Context, Allocation> {
  admit(plan: Resolved, context: Context): Promise<Allocation>;
}

/** Prepare without allocating. Callers can acquire their launch fence before admitting the resolved plan. */
export async function prepareLaunchPlan<Validated, Resolved, Context, Allocation>(
  validate: () => Validated | Promise<Validated>,
  resolve: (request: Validated) => Promise<Resolved>,
  selectPlacement: (plan: Resolved) => LaunchPlacement<Resolved, Context, Allocation>,
) {
  const resolved = await resolve(await validate());
  const placement = selectPlacement(resolved);
  return {
    resolved,
    admit: (context: Context) => placement.admit(resolved, context),
  };
}
