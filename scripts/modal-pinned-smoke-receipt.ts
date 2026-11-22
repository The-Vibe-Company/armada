import { parseLaunchAdmissionReceipt } from "../packages/core/src/contract/launch-response.ts";

export function parseExplicitPinnedAdmission<T>(reply: { sandbox?: { status?: string; templateManifest?: T } }) {
  if (reply.sandbox?.status !== "starting") return undefined;
  const { sandbox, ...responseFields } = reply;
  const { templateManifest, ...sandboxFields } = sandbox;
  const admission = parseLaunchAdmissionReceipt("modal", { ...responseFields, sandbox: sandboxFields });
  if (!admission) throw Error("Invalid explicit pinned Modal starting receipt.");
  return { ...admission, templateManifest };
}
