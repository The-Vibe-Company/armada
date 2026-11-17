import { decryptSecret } from "@armada/core/server";

/** One public identity contract for API responses and outbound notifications. */
export async function queuedPromptAliases(
  rows: { request_id: string; result_enc: Uint8Array<ArrayBuffer> | null }[],
  key: string | undefined,
): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  for (const row of rows) {
    if (!row.result_enc) continue;
    const receipt = JSON.parse(await decryptSecret(row.result_enc, key));
    if (typeof receipt.promptId === "string") aliases.set(receipt.promptId, row.request_id);
  }
  return aliases;
}
