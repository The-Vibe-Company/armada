import { validateSkillPins } from "./skillpack.ts";

/** Low to high priority. A later layer replaces the whole pin for a slug. */
export function mergeSkillPins(...layers: readonly string[][]): string[] {
  const pins = new Map<string, string>();
  for (const layer of layers) {
    validateSkillPins(layer);
    for (const pin of layer) pins.set(pin.split("@")[0]!.split("/").at(-1)!, pin);
  }
  const result = [...pins.values()];
  validateSkillPins(result);
  return result;
}
