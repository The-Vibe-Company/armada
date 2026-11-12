import { verifyReceipts } from "./template-skill-smoke.ts";

export class DefaultSkillSmokeFailure extends Error {
  readonly code = "invalid_response";
  constructor() {
    super("invalid_response");
  }
}
interface Io {
  request<T>(path: string, body: object): Promise<T>;
  step<T>(name: string, action: () => Promise<T>): Promise<T>;
}
/** Independent client oracle: no production merge helper is used to predict itself. */
export async function readDefaultPins(org: string, goldenId: string, io: Io): Promise<string[]> {
  const selected = new Map<string, string>();
  for (const scope of ["golden", "org", "personal"] as const) {
    const pins = await io.step(`default_skills_${scope}`, async () => {
      const result = await io.request<{ skills?: unknown }>("skills/defaults/get", {
        org,
        scope,
        ...(scope === "golden" ? { goldenId } : {}),
      });
      if (!Array.isArray(result?.skills) || result.skills.length > 20) throw new DefaultSkillSmokeFailure();
      const seen = new Set<string>();
      for (const pin of result.skills) {
        if (
          typeof pin !== "string" ||
          pin.length > 256 ||
          !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?@\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pin)
        )
          throw new DefaultSkillSmokeFailure();
        const slug = pin.split("@")[0]!.split("/").at(-1)!;
        if (seen.has(slug)) throw new DefaultSkillSmokeFailure();
        seen.add(slug);
      }
      return result.skills as string[];
    });
    for (const pin of pins) selected.set(pin.split("@")[0]!.split("/").at(-1)!, pin);
  }
  if (selected.size > 20) throw new DefaultSkillSmokeFailure();
  return [...selected.values()];
}

/** The launch and persisted status must agree on each effective exact pin. */
export function verifyDefaultReceipts(launch: unknown, status: unknown, pins: string[]) {
  verifyReceipts(launch, pins);
  verifyReceipts(status, pins);
  for (const pin of pins) {
    const a = launch.find((receipt) => receipt.reference === pin)!;
    const b = status.find((receipt) => receipt.reference === pin)!;
    for (const key of ["reference", "version", "skillId", "checksum", "origin"] as const)
      if (a[key] !== b[key]) throw new DefaultSkillSmokeFailure();
  }
}
