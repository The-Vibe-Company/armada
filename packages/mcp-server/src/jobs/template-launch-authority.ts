import { createTemplateService, GoldenError, type Sql, VaultError } from "@armada/core/server";
import { childLaunchAuthorized } from "../sandbox-access-child-launch.ts";

export interface LaunchAuthority {
  childOperationId?: string | undefined;
  templateReceiptId?: string | undefined;
}

export async function launchAuthorityCurrent(tx: Sql, sandboxId: string, authority: LaunchAuthority) {
  if (!(await childLaunchAuthorized(tx, sandboxId, authority.childOperationId))) return false;
  if (!authority.templateReceiptId) return true;
  try {
    await createTemplateService(tx).revalidateGoldenJob(tx, sandboxId, authority.templateReceiptId);
    return true;
  } catch (error) {
    if (error instanceof VaultError || error instanceof GoldenError) return false;
    throw error;
  }
}
