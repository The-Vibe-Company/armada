import { LaunchError } from "./launch-error.ts";
import { PROVIDER_LIMITS, type SandboxPlacementProviderId } from "./sandbox-provider.ts";
import { INVALID_SKILL_PINS_MESSAGE, validateSkillPins } from "./skill-pins.ts";

export function isLaunchTtlSeconds(provider: SandboxPlacementProviderId, value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PROVIDER_LIMITS[provider].maxTtlSeconds
  );
}

export function validateLaunchSkillPins(skills: unknown): asserts skills is string[] {
  try {
    validateSkillPins(skills);
  } catch {
    throw new LaunchError("invalid_request", INVALID_SKILL_PINS_MESSAGE);
  }
}
