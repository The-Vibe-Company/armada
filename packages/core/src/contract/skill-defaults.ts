import { z } from "zod";
import { INVALID_SKILL_PINS_MESSAGE, SKILL_PIN_PATTERN, validateSkillPins } from "../skill-pins.ts";
import type { Operation } from "./index.ts";

const identifier = z.guid();
const personalOrOrg = { org: identifier, scope: z.enum(["personal", "org"]) };
const golden = { org: identifier, scope: z.literal("golden"), goldenId: identifier };
const skills = z
  .array(z.string().max(256).regex(SKILL_PIN_PATTERN))
  .max(20)
  .refine((pins) => {
    try {
      validateSkillPins(pins);
      return true;
    } catch {
      return false;
    }
  }, INVALID_SKILL_PINS_MESSAGE)
  .describe(INVALID_SKILL_PINS_MESSAGE);
const output = z.strictObject({ skills });
const successHeaders = { "Cache-Control": z.literal("no-store") };
const errors = [
  "invalid",
  "unauthorized",
  "forbidden",
  "not_found",
  "unavailable",
  "dependency_unavailable",
  "internal",
];

export const skillDefaultOperations = {
  readSkillDefaults: {
    name: "readSkillDefaults",
    route: { method: "POST", path: "/api/v1/skills/defaults/get" },
    audience: "admin",
    readOnly: true,
    destructive: false,
    description: "Read skill defaults for the caller, organization, or visible snapshot.",
    input: { body: z.union([z.strictObject(personalOrOrg), z.strictObject(golden)]) },
    output,
    successHeaders,
    errors,
  },
  setSkillDefaults: {
    name: "setSkillDefaults",
    route: { method: "POST", path: "/api/v1/skills/defaults/set" },
    audience: "admin",
    readOnly: false,
    destructive: false,
    description: "Replace skill defaults for the selected scope. An empty list clears the defaults.",
    input: { body: z.union([z.strictObject({ ...personalOrOrg, skills }), z.strictObject({ ...golden, skills })]) },
    output,
    successHeaders,
    errors,
  },
} as const satisfies Record<string, Operation<z.ZodType, z.ZodType>>;
