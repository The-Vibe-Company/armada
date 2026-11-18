/** Declared sandbox outputs (#2570): one fixed directory and bounds shared by the collectors. */
export const OUTPUT_DIRECTORY = "/home/user/outputs";
export const OUTPUT_MAX_FILES = 32;
export const OUTPUT_MAX_BYTES = 32768;
/** Directory entries a collector inspects. A larger directory is unreadable now (the previous
 * snapshot stays), never a partial read that would drop unseen files. */
export const OUTPUT_MAX_ENTRIES = 4096;

/** Names every collector skips and the server refuses: no separators, control characters or dot entries. */
export function validOutputName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[^/\\]{1,255}$/.test(name) &&
    ![...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    name !== "." &&
    name !== ".."
  );
}
