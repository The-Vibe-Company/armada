import { readdirSync } from "node:fs";

// Replaced by the compiler for standalone binaries: no repository or environment
// variable is consulted by a deployed server. Source runs derive the same value.
declare const ARMADA_REQUIRED_MIGRATION: string;
const required =
  typeof ARMADA_REQUIRED_MIGRATION !== "undefined"
    ? ARMADA_REQUIRED_MIGRATION
    : readdirSync(new URL("../../../supabase/migrations/", import.meta.url))
        .filter((name) => /^\d{14}_.+\.sql$/.test(name))
        .sort()
        .at(-1)
        ?.slice(0, 14);

if (!required || !/^\d{14}$/.test(required)) {
  throw new Error("Cannot determine required database migration.");
}

export const REQUIRED_MIGRATION: string = required;
