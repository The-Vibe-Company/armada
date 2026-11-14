import { shellQuote } from "../packages/core/src/shell-quote.ts";
import { verifyDefaultReceipts } from "./default-skill-smoke.ts";
import { verifyReceipts } from "./template-skill-smoke.ts";

export interface SkillsProbeBinding {
  reference: string;
  projectDir: string;
  fileSha256: string;
}
export function isSkillsProbeBinding(value: unknown): value is SkillsProbeBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as SkillsProbeBinding;
  return (
    typeof v.reference === "string" &&
    v.reference.length <= 256 &&
    /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v.reference) &&
    typeof v.projectDir === "string" &&
    /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(v.projectDir) &&
    typeof v.fileSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.fileSha256)
  );
}
interface Io {
  request<T>(path: string, body: object): Promise<T>;
}
/** Read-only installed-content proof. No skill contents, credentials or lockfile leave the guest. */
export async function prepareSkillsProbe(
  template: { id: string; revision: number },
  binding: SkillsProbeBinding,
  io: Io,
) {
  if (!isSkillsProbeBinding(binding)) throw Error("invalid_skills_binding");
  const source = await io.request<{ revision?: { revision?: number; definition?: { skills?: unknown } } }>(
    "templates/get",
    template,
  );
  const pins = source?.revision?.definition?.skills;
  if (source?.revision?.revision !== template.revision || !Array.isArray(pins) || !pins.includes(binding.reference))
    throw Error("invalid_skills_binding");
  let launch: unknown;
  return {
    verifyManifest(manifest: { definition?: { skills?: unknown }; skillReceipts?: unknown }) {
      if (JSON.stringify(manifest.definition?.skills) !== JSON.stringify(pins)) throw Error("invalid_skills_binding");
      verifyReceipts(manifest.skillReceipts, pins);
      launch = manifest.skillReceipts;
    },
    async verify(id: string, provider: string, harness: string) {
      const status = await io.request<{ id?: string; skills?: unknown }>("sandbox/status", { id });
      if (status.id !== id) throw Error("invalid_skills_receipt");
      verifyDefaultReceipts(launch, status.skills, pins);
      const slug = binding.reference.split("@")[0]!.split("/").at(-1)!;
      // Claude consumes its own skill root; Codex/OpenCode consume the agent root.
      const root = harness === "claude" ? ".claude" : ".agents";
      const path = `${binding.projectDir}/${root}/skills/${slug}/SKILL.md`;
      const result = await io.request<{ exitCode?: number; timedOut?: boolean; stdout?: string }>("sandbox/exec", {
        id,
        command: `test -r ${shellQuote(path)} && sha256sum ${shellQuote(path)} | cut -d ' ' -f 1`,
        cwd: "/tmp",
        timeout_seconds: 30,
        ...(provider === "docker" ? { request_id: crypto.randomUUID() } : {}),
      });
      if (result.exitCode !== 0 || result.timedOut !== false || result.stdout?.trim() !== binding.fileSha256)
        throw Error("skills_content_mismatch");
    },
  };
}
