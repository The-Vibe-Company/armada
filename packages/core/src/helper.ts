import digests from "../helper/digests.json";
/** Closed slice-0 protocol. A receipt is evidence of installation, never guest authority. */
export interface HelperReceipt {
  version: string;
  digest: string;
  protocol: number;
  platform: "x86_64" | "aarch64";
  capabilities: string[];
  snapshotId: string;
}
export interface HelperRefusal {
  reason: "helper_missing" | "helper_receipt_invalid" | "helper_capability_unsupported";
  action: "rebuild_golden";
}
export type HelperNegotiation =
  | { status: "supported"; protocol: 1; capabilities: ["diagnose"] }
  | { status: "unsupported"; reason: "helper_missing" | "helper_receipt_invalid"; action: "rebuild_golden" };

export function negotiateHelper(
  receipt: HelperReceipt | null | undefined,
  snapshotId: string | null,
): HelperNegotiation {
  if (!receipt) return { status: "unsupported", reason: "helper_missing", action: "rebuild_golden" };
  if (
    receipt.version !== "0.1.0" ||
    receipt.protocol !== 1 ||
    typeof receipt.snapshotId !== "string" ||
    receipt.snapshotId.length === 0 ||
    receipt.snapshotId !== snapshotId ||
    !["x86_64", "aarch64"].includes(receipt.platform) ||
    (receipt.platform in digests && receipt.digest !== digests[receipt.platform]) ||
    !Array.isArray(receipt.capabilities) ||
    receipt.capabilities.length !== 1 ||
    receipt.capabilities[0] !== "diagnose"
  )
    return { status: "unsupported", reason: "helper_receipt_invalid", action: "rebuild_golden" };
  return { status: "supported", protocol: 1, capabilities: ["diagnose"] };
}
